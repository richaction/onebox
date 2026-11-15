use crate::{
    attachments::{normalize, relative_href, relative_link, Reference},
    markdown,
};
use pulldown_cmark::{CowStr, Event, LinkType, Tag};
use std::{collections::BTreeMap, ops::Range, path::Path};

pub(crate) struct Link<'a> {
    href: CowStr<'a>,
    source: Option<Range<usize>>,
    image: bool,
}

fn borrowed_range(text: &str, url: &CowStr<'_>) -> Option<Range<usize>> {
    let CowStr::Borrowed(url) = url else {
        return None;
    };
    let start = (url.as_ptr() as usize).checked_sub(text.as_ptr() as usize)?;
    let range = start..start + url.len();
    (text.get(range.clone()) == Some(url)).then_some(range)
}

// Escaped destinations may be allocated by pulldown-cmark. Locate the original
// token within the parser span and verify it by parsing that same token again.
fn escaped_range(
    text: &str,
    span: Range<usize>,
    delimiter: &str,
    url: &str,
) -> Option<Range<usize>> {
    let raw = text.get(span.clone())?;
    let mut matching = raw.match_indices(delimiter).filter_map(|(index, _)| {
        let tail = &raw[index + delimiter.len()..];
        let trimmed = tail.trim_start();
        let mut start = index + delimiter.len() + tail.len() - trimmed.len();
        let angled = trimmed.starts_with('<');
        let body = if angled {
            start += 1;
            &trimmed[1..]
        } else {
            trimmed
        };
        let mut escaped = false;
        let mut depth = 0;
        let mut end = body.len();
        for (index, ch) in body.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            match ch {
                '\\' => escaped = true,
                '>' if angled => {
                    end = index;
                    break;
                }
                '(' if !angled => depth += 1,
                ')' if !angled && depth > 0 => depth -= 1,
                ')' if !angled => {
                    end = index;
                    break;
                }
                ch if !angled && ch.is_whitespace() => {
                    end = index;
                    break;
                }
                _ => {}
            }
        }
        let mut sample = format!("[link](<{}>)", &body[..end]);
        if body[..end].contains("\\|") {
            sample = format!("| link |\n| --- |\n| {sample} |");
        }
        let same = markdown::parser(&sample).any(|event| {
            matches!(event, Event::Start(Tag::Link { dest_url, .. }) if dest_url.as_ref() == url)
        });
        same.then_some(span.start + start..span.start + start + end)
    });
    let first = matching.next()?;
    matching.next().is_none().then_some(first)
}

pub(crate) fn links(text: &str) -> Vec<Link<'_>> {
    let mut parser = markdown::relocation_parser(text).into_offset_iter();
    let mut links = Vec::new();
    while let Some((event, span)) = parser.next() {
        let (href, kind, id, image) = match event {
            Event::Start(Tag::Link {
                dest_url,
                link_type,
                id,
                ..
            }) => (dest_url, link_type, id, false),
            Event::Start(Tag::Image {
                dest_url,
                link_type,
                id,
                ..
            }) => (dest_url, link_type, id, true),
            _ => continue,
        };
        if relative_href(&href).is_none() {
            continue;
        }
        let source = borrowed_range(text, &href).or_else(|| {
            if kind == LinkType::Inline {
                escaped_range(text, span, "](", &href)
            } else {
                let definition = parser.reference_definitions().get(&id)?;
                escaped_range(text, definition.span.clone(), "]:", &href)
            }
        });
        links.push(Link {
            href,
            source,
            image,
        });
    }
    links
}

pub(crate) fn references(links: &[Link<'_>]) -> Vec<Reference> {
    let mut references = BTreeMap::new();
    for link in links {
        let image = references.entry(link.href.to_string()).or_insert(false);
        *image |= link.image;
    }
    references
        .into_iter()
        .map(|(href, image)| Reference { href, image })
        .collect()
}

pub(crate) fn rewrite(
    text: &str,
    links: &[Link<'_>],
    replace: impl Fn(&str) -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    let mut changes = BTreeMap::new();
    for link in links {
        if let Some(value) = replace(&link.href)? {
            let range = link
                .source
                .clone()
                .ok_or("无法安全定位 Markdown 链接，文件未移动")?;
            changes.insert(range.start, (range.end, value));
        }
    }
    if changes.is_empty() {
        return Ok(None);
    }
    let mut updated = String::with_capacity(text.len());
    let mut previous = 0;
    for (start, (end, value)) in changes {
        if start < previous {
            return Err("Markdown 链接范围重叠，文件未移动".into());
        }
        updated.push_str(&text[previous..start]);
        updated.push_str(&value);
        previous = end;
    }
    updated.push_str(&text[previous..]);
    Ok(Some(updated))
}

pub(crate) fn rebased_link(
    href: &str,
    old_dir: &Path,
    new_dir: &Path,
    source: &Path,
    destination: &Path,
) -> Result<Option<String>, String> {
    let Some((relative, suffix)) = relative_href(href) else {
        return Ok(None);
    };
    let previous = normalize(&old_dir.join(&relative));
    let updated = match previous.strip_prefix(source) {
        Ok(tail) if tail.as_os_str().is_empty() => destination.to_owned(),
        Ok(tail) => destination.join(tail),
        Err(_) => previous,
    };
    if updated == normalize(&new_dir.join(&relative)) {
        return Ok(None);
    }
    let mut href = relative_link(new_dir, &updated)?;
    if relative.ends_with('/') && !href.ends_with('/') {
        href.push('/');
    }
    href.push_str(suffix);
    Ok(Some(href))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_inline_and_reference_destinations_without_touching_labels_or_titles() {
        let original = "![[external link](outside.md)](assets/x\\(v1\\).png \"caption\")\r\n\r\n[ref][a]\r\n\r\n[a]: <one&amp;two.md> \"title\"\r\n";
        let moved = rewrite(original, &links(original), |href| {
            Ok(Some(format!("new/{href}")))
        })
        .unwrap()
        .unwrap();
        assert_eq!(moved, "![[external link](new/outside.md)](new/assets/x(v1).png \"caption\")\r\n\r\n[ref][a]\r\n\r\n[a]: <new/one&two.md> \"title\"\r\n");
    }

    #[test]
    fn keeps_yaml_front_matter_and_code_verbatim() {
        let input =
            "---\ntitle: \"[keep](page.md)\"\n---\n\n`[code](page.md)`\n\n[link](page.md)\n";
        let changed = rewrite(input, &links(input), |_| Ok(Some("new/page.md".into())))
            .unwrap()
            .unwrap();
        assert_eq!(
            changed,
            input.replace("[link](page.md)", "[link](new/page.md)")
        );
    }
}
