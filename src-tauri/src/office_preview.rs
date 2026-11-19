use objc2::{
    msg_send,
    rc::{Allocated, Retained},
    runtime::AnyClass,
    MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSBackingStoreType, NSView, NSWindow, NSWindowOrderingMode, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL};
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
};
use tauri::WebviewWindow;

#[link(name = "QuickLookUI", kind = "framework")]
extern "C" {}

thread_local! {
    static PREVIEW_WINDOW: RefCell<Option<Retained<NSWindow>>> = const { RefCell::new(None) };
}

fn show_on_main_thread(
    parent: &NSWindow,
    path: &Path,
    mtm: MainThreadMarker,
) -> Result<(), String> {
    let class = AnyClass::get(c"QLPreviewView").ok_or("无法启动 macOS 快速查看")?;
    let path = NSString::from_str(&path.to_string_lossy());
    let item = NSURL::fileURLWithPath(&path);
    let size = NSSize::new(800.0, 600.0);
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), size);
    // QLPreviewView is an NSView subclass, and Quick Look accepts file URLs as preview items.
    let view: Retained<NSView> = unsafe {
        let allocation: Allocated<NSView> = msg_send![class, alloc];
        let view: Option<Retained<NSView>> = msg_send![allocation, initWithFrame: rect];
        let view = view.ok_or("无法创建 Office 预览")?;
        let _: () = msg_send![&*view, setPreviewItem: &*item];
        view
    };
    let window = unsafe {
        let window = NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect,
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Resizable,
            NSBackingStoreType::Buffered,
            false,
        );
        window.setReleasedWhenClosed(false);
        window
    };
    window.setTitleWithRepresentedFilename(&path);
    window.setContentView(Some(&view));
    window.setMinSize(NSSize::new(400.0, 300.0));
    window.center();
    PREVIEW_WINDOW.with(|slot| {
        if let Some(previous) = slot.replace(Some(window.clone())) {
            if previous.isVisible() {
                previous.close();
            }
        }
    });
    unsafe { parent.addChildWindow_ordered(&window, NSWindowOrderingMode::Above) };
    window.makeKeyAndOrderFront(None);
    Ok(())
}

pub(crate) async fn show(window: WebviewWindow, path: PathBuf) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let result = (|| {
                let mtm = MainThreadMarker::new().ok_or("无法启动 macOS 快速查看")?;
                // Tauri supplies the NSWindow belonging to this webview on the main thread.
                let parent = unsafe { webview.ns_window().cast::<NSWindow>().as_ref() }
                    .ok_or("无法找到 Onebox 窗口")?;
                show_on_main_thread(parent, &path, mtm)
            })();
            let _ = send.send(result);
        })
        .map_err(|err| err.to_string())?;
    receive.await.map_err(|err| err.to_string())?
}
