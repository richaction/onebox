use crate::fs::{read_file, selected_path};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use pulldown_cmark::{Alignment, CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Mutex};
use tauri::{AppHandle, State};

const FIRST_BLOCKS: usize = 96;
const URL_ENCODE: &AsciiSet = &CONTROLS.add(b' ').add(b'<').add(b'>').add(b'"');

#[derive(Serialize)]
pub(crate) struct Node {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Value::is_null")]
    attrs: Value,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    content: Vec<Node>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    marks: Vec<Value>,
}

impl Node {
    fn new(kind: &'static str, attrs: Value) -> Self {
        Self {
            kind,
            attrs,
            content: Vec::new(),
            text: None,
            marks: Vec::new(),
        }
    }

    fn plain(kind: &'static str) -> Self {
        Self::new(kind, Value::Null)
    }

    fn push_text(&mut self, text: &str, marks: &[Value]) {
        if text.is_empty() {
            return;
        }
        if let Some(last) = self.content.last_mut() {
            if let Some(previous) = last.text.as_mut().filter(|_| last.marks == marks) {
                previous.push_str(text);
                return;
            }
        }
        let mut node = Node::plain("text");
        node.text = Some(text.to_owned());
        node.marks = marks.to_vec();
        self.content.push(node);
    }

    fn paragraph(&mut self) -> &mut Node {
        if !self
            .content
            .last()
            .is_some_and(|node| node.kind == "paragraph")
        {
            self.content.push(Node::plain("paragraph"));
        }
        self.content.last_mut().unwrap()
    }

    fn inline_parent(&mut self) -> &mut Node {
        match self.kind {
            "doc" | "listItem" | "blockquote" | "footnoteDefinition" => self.paragraph(),
            _ => self,
        }
    }
}

pub(crate) fn parser(source: &str) -> Parser<'_> {
    Parser::new_ext(source, markdown_options())
}

pub(crate) fn relocation_parser(source: &str) -> Parser<'_> {
    Parser::new_ext(
        source,
        markdown_options()
            | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
            | Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS,
    )
}

fn markdown_options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_MATH
}

fn url(url: &str) -> String {
    utf8_percent_encode(url, URL_ENCODE).to_string()
}

fn title(title: &str) -> Option<&str> {
    (!title.is_empty()).then_some(title)
}

fn cell_alignment(table: &Frame, row: &Frame) -> Option<&'static str> {
    match table.alignment.get(row.node.content.len()) {
        Some(Alignment::Left) => Some("left"),
        Some(Alignment::Center) => Some("center"),
        Some(Alignment::Right) => Some("right"),
        _ => None,
    }
}

struct Frame {
    node: Node,
    alignment: Vec<Alignment>,
    header: bool,
}

impl Frame {
    fn new(node: Node) -> Self {
        Self {
            node,
            alignment: Vec::new(),
            header: false,
        }
    }
}

// Pulldown parses the complete document before its top-level blocks are batched.
// Its reference map therefore also covers link definitions after the first viewport.
fn parse_document(source: &str) -> (Vec<Node>, bool) {
    let mut stack = vec![Frame::new(Node::plain("doc"))];
    let mut marks = Vec::new();
    let mut images: Vec<(Node, String)> = Vec::new();
    let mut footnotes = HashSet::new();
    let mut readonly = false;

    for event in parser(source) {
        if !images.is_empty() {
            match &event {
                Event::Start(Tag::Image { .. }) | Event::End(TagEnd::Image) => {}
                _ => {
                    let (_, alt) = images.last_mut().unwrap();
                    match event {
                        Event::Text(text) | Event::Code(text) => alt.push_str(&text),
                        Event::SoftBreak | Event::HardBreak => alt.push(' '),
                        _ => {}
                    }
                    continue;
                }
            }
        }
        let node = &mut stack.last_mut().unwrap().node;
        match event {
            Event::Start(tag) => {
                let block = match tag {
                    Tag::Paragraph | Tag::HtmlBlock => Node::plain("paragraph"),
                    Tag::Heading { level, .. } => {
                        Node::new("heading", json!({ "level": level as u8 }))
                    }
                    Tag::BlockQuote(_) => Node::plain("blockquote"),
                    Tag::CodeBlock(kind) => {
                        let language = match &kind {
                            CodeBlockKind::Fenced(info) if !info.trim().is_empty() => {
                                Some(info.trim())
                            }
                            _ => None,
                        };
                        Node::new("codeBlock", json!({ "language": language }))
                    }
                    Tag::List(Some(start)) => Node::new("orderedList", json!({ "start": start })),
                    Tag::List(None) => Node::plain("bulletList"),
                    Tag::Item => Node::plain("listItem"),
                    Tag::FootnoteDefinition(label) => {
                        readonly |= !footnotes.insert(label.to_lowercase())
                            || label
                                .chars()
                                .any(|ch| ch.is_whitespace() || matches!(ch, '[' | ']' | '\\'));
                        Node::new("footnoteDefinition", json!({ "label": &*label }))
                    }
                    Tag::Table(alignment) => {
                        let mut table = Frame::new(Node::plain("table"));
                        table.alignment = alignment;
                        stack.push(table);
                        continue;
                    }
                    Tag::TableHead => {
                        let mut row = Frame::new(Node::plain("tableRow"));
                        row.header = true;
                        stack.push(row);
                        continue;
                    }
                    Tag::TableRow => Node::plain("tableRow"),
                    Tag::TableCell => {
                        let row = &stack[stack.len() - 1];
                        let table = &stack[stack.len() - 2];
                        Node::new(
                            if row.header {
                                "tableHeader"
                            } else {
                                "tableCell"
                            },
                            json!({ "align": cell_alignment(table, row) }),
                        )
                    }
                    Tag::Emphasis | Tag::Strong | Tag::Strikethrough | Tag::Link { .. } => {
                        marks.push(match tag {
                            Tag::Emphasis => json!({ "type": "italic" }),
                            Tag::Strong => json!({ "type": "bold" }),
                            Tag::Strikethrough => json!({ "type": "strike" }),
                            Tag::Link { dest_url, title: link_title, .. } =>
                                json!({ "type": "link", "attrs": { "href": url(&dest_url), "title": title(&link_title) } }),
                            _ => unreachable!(),
                        });
                        continue;
                    }
                    Tag::Image {
                        dest_url,
                        title: image_title,
                        ..
                    } => {
                        let image = Node::new(
                            "image",
                            json!({ "src": url(&dest_url), "title": title(&image_title) }),
                        );
                        images.push((image, String::new()));
                        continue;
                    }
                    // These tags require explicit parser options that are disabled above.
                    _ => unreachable!("unsupported parser tag: {tag:?}"),
                };
                stack.push(Frame::new(block));
            }
            Event::End(
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link,
            ) => {
                marks.pop();
            }
            Event::End(TagEnd::Image) => {
                let (mut image, alt) = images.pop().unwrap();
                if let Some((_, parent_alt)) = images.last_mut() {
                    parent_alt.push_str(&alt);
                } else {
                    image.attrs["alt"] = json!(alt);
                    image.marks = marks.clone();
                    node.inline_parent().content.push(image);
                }
            }
            Event::End(end) => {
                let mut finished = stack.pop().unwrap().node;
                match end {
                    TagEnd::Item
                        if !finished
                            .content
                            .first()
                            .is_some_and(|node| node.kind == "paragraph") =>
                    {
                        finished.content.insert(0, Node::plain("paragraph"));
                    }
                    TagEnd::BlockQuote(_) | TagEnd::FootnoteDefinition
                        if finished.content.is_empty() =>
                    {
                        finished.content.push(Node::plain("paragraph"));
                    }
                    TagEnd::TableCell => {
                        let mut paragraph = Node::plain("paragraph");
                        paragraph.content = std::mem::take(&mut finished.content);
                        finished.content.push(paragraph);
                    }
                    TagEnd::CodeBlock => {
                        if let Some(text) = finished
                            .content
                            .last_mut()
                            .and_then(|node| node.text.as_mut())
                        {
                            if text.ends_with('\n') {
                                text.pop();
                            }
                            if text.is_empty() {
                                finished.content.pop();
                            }
                        }
                    }
                    _ => {}
                }
                stack.last_mut().unwrap().node.content.push(finished);
            }
            Event::Text(text) => node.inline_parent().push_text(&text, &marks),
            Event::Code(code) => {
                marks.push(json!({ "type": "code" }));
                node.inline_parent().push_text(&code, &marks);
                marks.pop();
            }
            Event::InlineMath(ref latex) | Event::DisplayMath(ref latex) => {
                let display = matches!(event, Event::DisplayMath(_));
                let mut math = Node::new("math", json!({ "latex": &**latex, "display": display }));
                math.marks = marks.clone();
                node.inline_parent().content.push(math);
            }
            Event::SoftBreak => node.inline_parent().push_text("\n", &marks),
            Event::HardBreak => {
                let mut br = Node::plain("hardBreak");
                br.marks = marks.clone();
                node.inline_parent().content.push(br);
            }
            Event::FootnoteReference(label) => {
                let mut reference = Node::new("footnoteReference", json!({ "label": &*label }));
                reference.marks = marks.clone();
                node.inline_parent().content.push(reference);
            }
            Event::TaskListMarker(checked) => {
                if let Some(item) = stack
                    .iter_mut()
                    .rev()
                    .find(|frame| frame.node.kind == "listItem")
                {
                    item.node.attrs = json!({ "checked": checked });
                }
            }
            Event::Rule => node.content.push(Node::plain("horizontalRule")),
            Event::Html(raw) | Event::InlineHtml(raw) => {
                let trimmed = raw.trim();
                let safe_comment = trimmed.starts_with("<!--")
                    && trimmed.ends_with("-->")
                    && trimmed.find("-->") == Some(trimmed.len() - 3)
                    && !trimmed.contains(['\r', '\n']);
                readonly |= !safe_comment;
                node.inline_parent()
                    .push_text(raw.trim_end_matches('\n'), &marks);
            }
        }
    }

    let mut root = stack.pop().unwrap().node;
    if root.content.is_empty() {
        root.content.push(Node::plain("paragraph"));
    }
    (root.content, readonly)
}

#[derive(Default)]
pub(crate) struct PendingDocument {
    id: u64,
    blocks: std::vec::IntoIter<Node>,
}

#[derive(Serialize)]
pub(crate) struct DocumentStart {
    id: u64,
    blocks: Vec<Node>,
    total: usize,
    readonly: bool,
}

#[tauri::command]
pub(crate) async fn open_document(
    app: AppHandle,
    pending: State<'_, Mutex<PendingDocument>>,
    path: String,
) -> Result<DocumentStart, String> {
    let path = selected_path(&app, path)?;
    let id = {
        let mut next = pending.lock().map_err(|err| err.to_string())?;
        next.id += 1;
        next.blocks = Vec::new().into_iter();
        next.id
    };
    let text = read_file(path).await.map_err(|err| err.to_string())?;
    let (blocks, readonly) = tokio::task::spawn_blocking(move || parse_document(&text))
        .await
        .map_err(|err| err.to_string())?;
    let mut next = pending.lock().map_err(|err| err.to_string())?;
    if next.id != id {
        return Err("document opening was superseded".into());
    }
    let total = blocks.len();
    next.blocks = blocks.into_iter();
    let blocks = next.blocks.by_ref().take(FIRST_BLOCKS).collect();
    Ok(DocumentStart {
        id,
        blocks,
        total,
        readonly,
    })
}

#[tauri::command]
pub(crate) fn document_batch(
    pending: State<'_, Mutex<PendingDocument>>,
    id: u64,
    limit: usize,
) -> Result<Vec<Node>, String> {
    let mut next = pending.lock().map_err(|err| err.to_string())?;
    if next.id != id {
        return Err("document is no longer loading".into());
    }
    Ok(next.blocks.by_ref().take(limit.clamp(1, 512)).collect())
}

#[tauri::command]
pub(crate) fn release_document(pending: State<'_, Mutex<PendingDocument>>, id: u64) {
    if let Ok(mut next) = pending.lock() {
        if next.id == id {
            next.blocks = Vec::new().into_iter();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_relative_references_and_gfm_from_the_same_context() {
        let source = "![A *caption*][photo]\n\n- [x] done\n  - child\n\n| A | B |\n| :--- | ---: |\n| a | b |\n\nText[^note].\n\n[^note]: body\n\n[photo]: assets/photo.png";
        let (blocks, readonly) = parse_document(source);
        assert!(!readonly);
        let blocks = serde_json::to_value(blocks).unwrap();
        assert_eq!(
            blocks[0]["content"][0]["attrs"],
            json!({"alt": "A caption", "src": "assets/photo.png", "title": null})
        );
        assert_eq!(blocks[1]["content"][0]["attrs"]["checked"], true);
        assert_eq!(
            blocks[1]["content"][0]["content"][0]["content"][0]["text"],
            "done"
        );
        assert_eq!(
            blocks[2]["content"][0]["content"][1]["attrs"]["align"],
            "right"
        );
        assert_eq!(blocks[3]["content"][1]["attrs"]["label"], "note");
        assert_eq!(blocks[4]["attrs"]["label"], "note");
    }

    #[test]
    fn preserves_formula_source_and_chart_fences() {
        let source = r#"面积 $A=\pi r^2$，金额 \$1,234.50。

$$
\begin{bmatrix}a & b \\ c & d\end{bmatrix}
$$

```echarts
{"series":[]}
```"#;
        let (blocks, readonly) = parse_document(source);
        assert!(!readonly);
        assert_eq!(blocks[0].content[1].attrs, json!({"latex": r"A=\pi r^2", "display": false}));
        assert_eq!(blocks[1].content[0].attrs, json!({"latex": "\n\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}\n", "display": true}));
        assert_eq!(blocks[2].attrs["language"], "echarts");
    }

    #[test]
    fn protects_html_and_keeps_code_text() {
        let (blocks, readonly) = parse_document("<div>unsafe</div>\n\n```rs\nline\n```");
        assert!(readonly);
        assert_eq!(blocks[1].content[0].text.as_deref(), Some("line"));
    }
}
