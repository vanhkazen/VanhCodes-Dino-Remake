import Renderer from "./renderer.js";
import AudioManager from "./audio.js";
import Game from "./game.js";

const CANVAS_ID = "game-canvas";
const FINAL_SCENE_SCORE = 800;

let bootAttempted = false;
let activeApplication = null;
let readyHandler = null;

function showMessage(message, { fatal = false } = {}) {
  const canvas = globalThis.document?.getElementById?.(CANVAS_ID) ?? null;
  const host = canvas?.parentElement ?? globalThis.document?.querySelector?.("main") ?? globalThis.document?.body;
  if (!host || !globalThis.document?.createElement) return;

  let notice = globalThis.document.getElementById("game-status-message");
  if (!notice) {
    notice = globalThis.document.createElement("p");
    notice.id = "game-status-message";
    notice.setAttribute("role", fatal ? "alert" : "status");
    notice.className = "game-status-message";
    if (canvas?.parentElement === host) host.insertBefore(notice, canvas);
    else host.appendChild(notice);
  }
  notice.setAttribute("role", fatal ? "alert" : "status");
  notice.textContent = message;
  if (fatal && canvas) canvas.hidden = true;
}

function disposeApplication(application) {
  if (!application || application.disposed) return;
  application.disposed = true;
  application.resizeObserver?.disconnect();
  if (application.resizeFrameId !== null) {
    try { globalThis.cancelAnimationFrame?.(application.resizeFrameId); } catch (error) {
      console.warn("Could not cancel a pending canvas resize.", error);
    }
  }
  if (application.onWindowResize) {
    globalThis.window?.removeEventListener?.("resize", application.onWindowResize);
    globalThis.window?.removeEventListener?.("orientationchange", application.onWindowResize);
    globalThis.window?.visualViewport?.removeEventListener?.("resize", application.onWindowResize);
  }
  if (application.onPageHide) {
    globalThis.window?.removeEventListener?.("pagehide", application.onPageHide);
  }

  // Game.destroy() owns disposal of the injected AudioManager.
  if (application.game) {
    try { application.game.destroy(); } catch (error) {
      console.error("Game cleanup failed.", error);
    }
  } else if (application.audio) {
    try { application.audio.dispose(); } catch (error) {
      console.warn("Audio cleanup failed.", error);
    }
  }
  if (activeApplication === application) activeApplication = null;
}

function setupResize(application) {
  const { renderer, canvas, game } = application;
  let pendingSize = null;
  const syncSize = () => {
    if (application.disposed) return;
    const size = pendingSize;
    pendingSize = null;
    try {
      renderer.resize(size?.width, size?.height, globalThis.devicePixelRatio ?? 1);
      if (game && !game.destroyed) {
        renderer.render(game.getSnapshot());
      }
    } catch (error) {
      console.error("Canvas resize failed.", error);
      showMessage("Không thể điều chỉnh kích thước vùng trò chơi. Hãy thử tải lại trang.");
    }
  };
  const queueResize = (size = null) => {
    pendingSize = size;
    if (application.resizeFrameId !== null) return;
    const requestFrame = globalThis.requestAnimationFrame;
    if (typeof requestFrame === "function") {
      application.resizeFrameId = requestFrame(() => {
        application.resizeFrameId = null;
        syncSize();
      });
    } else {
      syncSize();
    }
  };

  // Do an initial DPR-aware sync, then coalesce subsequent resize notifications.
  renderer.resize(undefined, undefined, globalThis.devicePixelRatio ?? 1);
  const ResizeObserverClass = globalThis.ResizeObserver;
  if (typeof ResizeObserverClass === "function") {
    application.resizeObserver = new ResizeObserverClass((entries) => {
      const entry = entries?.[entries.length - 1];
      if (entry?.contentRect) {
        // Include the canvas border so the observed CSS size matches its visible box.
        const rect = canvas.getBoundingClientRect?.();
        queueResize({ width: rect?.width ?? entry.contentRect.width, height: rect?.height ?? entry.contentRect.height });
      }
    });
    application.resizeObserver.observe(canvas);
  }

  application.onWindowResize = () => queueResize();
  globalThis.window?.addEventListener?.("resize", application.onWindowResize, { passive: true });
  globalThis.window?.addEventListener?.("orientationchange", application.onWindowResize, { passive: true });
  globalThis.window?.visualViewport?.addEventListener?.("resize", application.onWindowResize, { passive: true });
}

function boot() {
  if (bootAttempted) return;
  bootAttempted = true;

  let canvas = null;
  let audio = null;
  let game = null;
  let application = null;
  try {
    canvas = globalThis.document?.getElementById?.(CANVAS_ID) ?? null;
    if (!canvas || typeof canvas.getContext !== "function") {
      throw new Error("Không tìm thấy vùng Canvas của trò chơi.");
    }

    let context = null;
    try { context = canvas.getContext("2d"); } catch { /* Reported below as an unsupported Canvas. */ }
    if (!context) {
      throw new Error("Trình duyệt này không hỗ trợ Canvas 2D.");
    }

    const renderer = new Renderer(canvas);

    // Audio is optional: failure to create Web Audio must not block gameplay.
    try {
      audio = new AudioManager();
      audio.init(); // Creates a suspended context only; Game unlocks it on user input.
    } catch (error) {
      console.warn("Web Audio is unavailable; the game will run silently.", error);
      try { audio?.dispose?.(); } catch { /* Best effort cleanup. */ }
      audio = null;
    }

    game = new Game({
      renderer,
      audio,
      config: { finalSceneScore: FINAL_SCENE_SCORE },
    });

    application = {
      canvas,
      renderer,
      audio,
      game,
      resizeObserver: null,
      resizeFrameId: null,
      onWindowResize: null,
      onPageHide: null,
      disposed: false,
    };
    activeApplication = application;
    setupResize(application);

    application.onPageHide = () => disposeApplication(application);
    globalThis.window?.addEventListener?.("pagehide", application.onPageHide, { once: true });

    if (!game.start()) {
      throw new Error("Không thể khởi động vòng lặp hoạt ảnh trong trình duyệt này.");
    }
  } catch (error) {
    if (application) {
      disposeApplication(application);
    } else if (game) {
      try { game.destroy(); } catch (cleanupError) {
        console.error("Game cleanup failed after initialization error.", cleanupError);
      }
    } else {
      try { audio?.dispose?.(); } catch (cleanupError) {
        console.warn("Audio cleanup failed after initialization error.", cleanupError);
      }
    }
    console.error("Game initialization failed.", error);
    showMessage(error instanceof Error ? error.message : "Không thể khởi tạo trò chơi.", { fatal: true });
  }
}

if (globalThis.document) {
  if (globalThis.document.readyState === "loading") {
    readyHandler = () => {
      globalThis.document.removeEventListener("DOMContentLoaded", readyHandler);
      readyHandler = null;
      boot();
    };
    globalThis.document.addEventListener("DOMContentLoaded", readyHandler, { once: true });
  } else {
    boot();
  }
}
