/** Canvas-only rendering for VanhCodes Dino Remake. */

export const RENDERER_DEFAULTS = Object.freeze({
  logicalWidth: 900,
  logicalHeight: 300,
  groundY: 180,
  background: "#f7f7f7",
  ink: "#535353",
  secondaryInk: "#777777",
  accent: "#d77b83",
  maxDevicePixelRatio: 3,
});

export const FINAL_SCENE_LINES = Object.freeze([
  "Anh vượt ngàn chông gai, cụ thể là gai xương rồng đến trao em bó hoa.",
  "Em trao lại anh cái phổi, cụ thể là phổi bạn - phản bội.",
]);

export const FinalReactionPhase = Object.freeze({
  INTRO: "intro",
  NOTICE: "notice",
  SHOCK: "shock",
  LOOK_BACK: "lookBack",
  WOBBLE: "wobble",
  FALL: "fall",
  REST: "rest",
});

const GAME_STATES = Object.freeze({
  READY: "ready",
  RUNNING: "running",
  GAME_OVER: "gameOver",
  FINAL_APPROACH: "finalApproach",
  FINAL_RUNOUT: "finalRunout",
  FINAL_STOP: "finalStop",
  FINAL_TRANSITION: "finalTransition",
  FINAL_SCENE: "finalScene",
  PAUSED: "paused",
});

const DINO_STATES = Object.freeze({
  RUNNING: "running",
  JUMPING: "jumping",
  FALLING: "falling",
  STOPPED: "stopped",
  DEAD: "dead",
});

const FINAL_REACTION_TIMING = Object.freeze({
  lookStart: 4.8,
  lookDuration: 0.45,
  shockDuration: 0.6,
  lookBackDuration: 0.55,
  stumbleDuration: 0.65,
  fallDuration: 0.7,
});

/**
 * `render(snapshot)` expects a plain game snapshot:
 * {
 *   state, score, highScore, elapsedTime, speed,
 *   dinosaur: Dinosaur.getSnapshot(),
 *   obstacles: Obstacles.getObstacles() | Obstacles.getSnapshot(),
 *   groundY, finalScene: { elapsedTime }
 * }
 * All world positions use a top-left origin and logical pixels.
 */
export class Renderer {
  constructor(canvasOrContext, options = {}) {
    const contextLike = canvasOrContext && typeof canvasOrContext.clearRect === "function";
    this.canvas = contextLike ? canvasOrContext.canvas : canvasOrContext;
    this.context = contextLike ? canvasOrContext : this.canvas?.getContext?.("2d");

    if (!this.canvas || !this.context || typeof this.context.clearRect !== "function") {
      throw new TypeError("Renderer requires an HTML canvas or a CanvasRenderingContext2D.");
    }

    this.config = Object.freeze({ ...RENDERER_DEFAULTS, ...options });
    this.explicitTouchMode = options.touchMode;
    this.viewportWidth = this.config.logicalWidth;
    this.viewportHeight = this.config.logicalHeight;
    this.pixelRatio = 1;
    this.renderScale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.cameraOffsetY = 0;
    this.visibleLogicalHeight = this.config.logicalHeight;
    this.touchMode = this.explicitTouchMode ?? detectTouchMode();
    this.lastSnapshot = null;
    this.resize();
  }

  /** Resize the backing bitmap to CSS dimensions × DPR without distorting the world. */
  resize(width, height, devicePixelRatio) {
    const rect = this.canvas.getBoundingClientRect?.();
    const cssWidth = positiveOr(width, rect?.width, this.canvas.clientWidth, this.config.logicalWidth);
    const cssHeight = positiveOr(height, rect?.height, this.canvas.clientHeight, this.config.logicalHeight);
    const reportedDpr = devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    const dpr = Math.min(this.config.maxDevicePixelRatio, Math.max(1, Number(reportedDpr) || 1));

    this.viewportWidth = cssWidth;
    this.viewportHeight = cssHeight;
    this.pixelRatio = dpr;
    if (this.explicitTouchMode === undefined) {
      this.touchMode = detectTouchMode() || cssWidth <= 768;
    }
    const backingWidth = Math.max(1, Math.round(cssWidth * dpr));
    const backingHeight = Math.max(1, Math.round(cssHeight * dpr));
    const bitmapChanged = this.canvas.width !== backingWidth || this.canvas.height !== backingHeight;
    // Assigning either dimension clears the bitmap, so skip it when size is unchanged.
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
    this._applyLogicalTransform();
    this.context.imageSmoothingEnabled = false;
    if (bitmapChanged && this.lastSnapshot) {
      this.render(this.lastSnapshot);
    }
    return { width: this.canvas.width, height: this.canvas.height, devicePixelRatio: dpr };
  }

  /** Clear the complete backing bitmap, independent of the logical transform. */
  clear() {
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._applyLogicalTransform();
  }

  /** Draw one frame from an immutable-by-convention game snapshot. */
  render(snapshot = {}) {
    if (!snapshot || typeof snapshot !== "object") {
      throw new TypeError("render(snapshot) expects a snapshot object.");
    }

    this.lastSnapshot = snapshot;
    this.clear();
    this._applyLogicalTransform();
    const ctx = this.context;
    const groundY = finiteOr(snapshot.groundY, this.config.groundY);
    const elapsedTime = finiteOr(snapshot.elapsedTime, finiteOr(snapshot.time, 0));
    const speed = Math.max(0, finiteOr(snapshot.speed, 0));
    const state = snapshot.state ?? GAME_STATES.READY;
    const worldOffset = finiteOr(snapshot.worldOffset, elapsedTime * speed);
    const obstacles = normalizeObstacles(snapshot.obstacles);
    const dinosaur = normalizeDinosaur(snapshot.dinosaur);

    this._drawBackground(ctx, elapsedTime, worldOffset);
    this._drawGround(ctx, groundY, worldOffset);

    if (state === GAME_STATES.FINAL_SCENE) {
      this._drawFinalScene(ctx, snapshot, dinosaur, groundY, elapsedTime);
    } else {
      for (const obstacle of obstacles) this._drawObstacle(ctx, obstacle);
      if (dinosaur) this._drawDinosaur(ctx, dinosaur);
      this._withScreenTransform(() => {
        this._drawHud(ctx, snapshot);
        this._drawGameMessage(ctx, state, groundY);
        if (state === GAME_STATES.FINAL_TRANSITION) this._drawFinalTransition(ctx, snapshot);
      });
    }
  }

  /** Return the current reaction phase of the primary Dino in Final Scene. */
  getFinalReactionPhase(sceneTime = 0) {
    const t = Math.max(0, finiteOr(sceneTime, 0));
    const timing = FINAL_REACTION_TIMING;
    const lookEnd = timing.lookStart + timing.lookDuration;
    const shockEnd = lookEnd + timing.shockDuration;
    const lookBackEnd = shockEnd + timing.lookBackDuration;
    const stumbleEnd = lookBackEnd + timing.stumbleDuration;
    const fallEnd = stumbleEnd + timing.fallDuration;

    if (t < timing.lookStart) return FinalReactionPhase.INTRO;
    if (t < lookEnd) return FinalReactionPhase.NOTICE;
    if (t < shockEnd) return FinalReactionPhase.SHOCK;
    if (t < lookBackEnd) return FinalReactionPhase.LOOK_BACK;
    if (t < stumbleEnd) return FinalReactionPhase.WOBBLE;
    if (t < fallEnd) return FinalReactionPhase.FALL;
    return FinalReactionPhase.REST;
  }

  _applyLogicalTransform() {
    const backingWidth = this.canvas.width || this.config.logicalWidth;
    const backingHeight = this.canvas.height || this.config.logicalHeight;
    const scale = Math.min(
      backingWidth / this.config.logicalWidth,
      backingHeight / this.config.logicalHeight,
    );
    this.renderScale = scale;
    this.offsetX = Math.floor((backingWidth - this.config.logicalWidth * scale) / 2);
    this.visibleLogicalHeight = backingHeight / scale;
    const extraHeight = Math.max(0, this.visibleLogicalHeight - this.config.logicalHeight);
    // Portrait height becomes extra sky/ground space; gameplay coordinates and scale stay intact.
    this.cameraOffsetY = (this.touchMode || extraHeight > 0) ? extraHeight * 0.7 : 0;
    this.offsetY = this.cameraOffsetY * scale;
    this.context.setTransform(scale, 0, 0, scale, this.offsetX, this.offsetY);
    this.context.imageSmoothingEnabled = false;
  }

  /** Draw HUD and messages in viewport coordinates, outside the portrait world offset. */
  _withScreenTransform(draw) {
    this.context.save();
    this.context.setTransform(this.renderScale, 0, 0, this.renderScale, this.offsetX, 0);
    draw();
    this.context.restore();
    this._applyLogicalTransform();
  }

  _drawBackground(ctx, elapsedTime, worldOffset) {
    ctx.fillStyle = this.config.background;
    ctx.fillRect(0, -this.cameraOffsetY, this.config.logicalWidth, this.visibleLogicalHeight);

    // Small block clouds move independently of obstacles and never resemble hazards.
    const cloudPositions = [
      { baseX: 120, y: this.touchMode ? -this.cameraOffsetY + this.visibleLogicalHeight * 0.2 : 45, width: 38 },
      { baseX: 430, y: this.touchMode ? -this.cameraOffsetY + this.visibleLogicalHeight * 0.3 : 72, width: 48 },
      { baseX: 730, y: this.touchMode ? -this.cameraOffsetY + this.visibleLogicalHeight * 0.16 : 38, width: 34 },
    ];
    const drift = (worldOffset * 0.08 + elapsedTime * 8) % (this.config.logicalWidth + 70);
    ctx.fillStyle = "#dedede";
    for (let index = 0; index < cloudPositions.length; index += 1) {
      const cloud = cloudPositions[index];
      const x = wrap(cloud.baseX - drift - index * 115, -cloud.width - 10, this.config.logicalWidth + 20);
      this._drawCloud(ctx, x, cloud.y, cloud.width);
    }
  }

  _drawCloud(ctx, x, y, width) {
    const unit = 4;
    const left = Math.round(x);
    const top = Math.round(y);
    ctx.fillRect(left + unit, top + unit, width - unit * 2, unit * 2);
    ctx.fillRect(left + unit * 2, top, width - unit * 4, unit * 2);
    ctx.fillRect(left, top + unit * 2, width, unit * 2);
  }

  _drawGround(ctx, groundY, worldOffset) {
    const baseline = Math.round(groundY);
    ctx.fillStyle = this.config.ink;
    ctx.fillRect(0, baseline, this.config.logicalWidth, 2);

    // Deterministic ground flecks create motion without adding fake obstacles.
    const spacing = 43;
    const phase = Math.floor(worldOffset / 3) % spacing;
    for (let x = -phase; x < this.config.logicalWidth; x += spacing) {
      const markX = Math.round(x + 9);
      const markY = baseline + 7 + (Math.floor((x + phase) / spacing) % 2) * 3;
      ctx.fillRect(markX, markY, 3, 1);
    }
  }

  _drawDinosaur(ctx, dino, override = {}) {
    const bounds = override.bounds ?? dino.bounds ?? {
      x: dino.x ?? 40,
      y: dino.y ?? this.config.groundY - 48,
      width: dino.width ?? 44,
      height: dino.height ?? 48,
    };
    const state = override.state ?? dino.state ?? dino.animation?.name ?? DINO_STATES.RUNNING;
    const frame = Math.max(0, Math.floor(finiteOr(override.frame, dino.animation?.frame ?? 0)));
    const palette = override.palette ?? this.config.ink;
    const x = Math.round(bounds.x);
    const y = Math.round(bounds.y);
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const reaction = override.reaction ?? null;

    ctx.save();
    ctx.fillStyle = palette;
    if (override.facing === "left") {
      // Mirror within this dinosaur's own bounds so the eye, muzzle, and tail flip together.
      ctx.translate(2 * x + width, 0);
      ctx.scale(-1, 1);
    }
    if (state === DINO_STATES.DEAD) {
      this._drawStandingDino(ctx, x, y, width, height, frame, palette, true, null, reaction);
    } else if (state === DINO_STATES.JUMPING || state === DINO_STATES.FALLING) {
      this._drawStandingDino(ctx, x, y, width, height, frame, palette, false, state, reaction);
    } else {
      this._drawStandingDino(ctx, x, y, width, height, frame, palette, false, null, reaction);
    }
    ctx.restore();
  }

  _drawStandingDino(ctx, x, y, width, height, frame, color, dead, airPose = null, reaction = null) {
    const sx = width / 44;
    const sy = height / 48;
    const outlineColor = this.config.background ?? "#f7f7f7";

    const fillBlock = (px, py, pw, ph, fill) => {
      ctx.fillStyle = fill;
      ctx.fillRect(
        Math.round(x + px * sx),
        Math.round(y + py * sy),
        Math.max(1, Math.round(pw * sx)),
        Math.max(1, Math.round(ph * sy)),
      );
    };

    // Các khối đặc gối chồng lên nhau (Overlapping Solid Blocks) giúp triệt tiêu 100% khe sọc sub-pixel
    const bodyBlocks = [
      // 1. Đầu, mõm và hàm dưới (gối chồng dọc từ y=2 xuống y=22)
      [22, 2, 16, 12],
      [20, 4, 20, 10],
      [20, 10, 10, 12],
      [20, dead ? 17 : 16, 16, 2],

      // 2. Cổ, thân, lưng bậc thang và bụng (các khối đặc chồng khít vào nhau)
      [18, 18, 10, 18],
      [16, 20, 14, 14],
      [12, 22, 18, 12],
      [10, 24, 20, 8],
      [8, 26, 22, 4],
      [6, 28, 20, 10],
      [4, 28, 22, 8],
      [2, 28, 26, 6],
      [0, 28, 30, 4],

      // 3. Tay nhỏ phía trước và móng (gối vào thân ở x=26..30)
      [26, 22, 8, 2],
      [32, 22, 2, 4],

      // 4. Đuôi cong bên trái (cắm sâu vào khối thân tại y=28..32)
      [0, 22, 2, 10],
      [0, 24, 4, 8],
      [0, 26, 6, 6],
    ];

    // 5. Chân (gối trực tiếp vào phần hông từ y=34 để không bị đứt nét ngang)
    let legBlocks;
    if (dead || (airPose === null && reaction !== null)) {
      legBlocks = [
        [8, 34, 6, 6],
        [8, 36, 4, 8],
        [8, 40, 2, 8],
        [8, 46, 4, 2],
        [18, 34, 6, 6],
        [20, 36, 4, 8],
        [20, 40, 2, 8],
        [20, 46, 4, 2],
      ];
    } else if (airPose === DINO_STATES.JUMPING || airPose === DINO_STATES.FALLING) {
      legBlocks = [
        [8, 34, 6, 6],
        [8, 38, 4, 8],
        [18, 34, 6, 6],
        [20, 38, 4, 8],
      ];
    } else if (frame % 2 === 0) {
      // Frame chạy 0: Chân trái chạm đất, chân phải co lên
      legBlocks = [
        [8, 34, 6, 6],
        [8, 36, 4, 8],
        [8, 40, 2, 8],
        [8, 46, 4, 2],
        [18, 34, 4, 8],
        [18, 40, 6, 2],
      ];
    } else {
      // Frame chạy 1: Chân trái co lên, chân phải chạm đất
      legBlocks = [
        [8, 34, 6, 6],
        [10, 38, 6, 4],
        [18, 34, 6, 6],
        [20, 36, 4, 8],
        [20, 40, 2, 8],
        [20, 46, 4, 2],
      ];
    }

    const allBlocks = [...bodyBlocks, ...legBlocks];

    // Lớp 1 (Pass 1): Viền cắt nền (#f7f7f7) quanh Dino tạo hiệu ứng tách đường mặt đất
    for (const [bx, by, bw, bh] of allBlocks) {
      fillBlock(bx - 2, by - 2, bw + 4, bh + 4, outlineColor);
    }

    // Lớp 2 (Pass 2): Vẽ phần thân khủng long đặc, liền khối
    for (const [bx, by, bw, bh] of allBlocks) {
      fillBlock(bx, by, bw, bh, color);
    }

    // Lớp 3 (Pass 3): Vẽ mắt
    const eyeShift = clamp(Math.round(reaction?.eyeOffset ?? 0), -1, 1) * 2;
    if (dead || reaction?.surprised) {
      fillBlock(22, 4, 6, 6, outlineColor);
      fillBlock(24 + eyeShift, 6, 2, 2, dead ? "#d77b83" : color);
    } else {
      fillBlock(24 + eyeShift, 6, 2, 2, outlineColor);
    }
  }

  _drawObstacle(ctx, obstacle) {
    if (obstacle.type === "pterodactyl") {
      this._drawPterodactyl(ctx, obstacle);
    } else if (obstacle.type === "cactus") {
      this._drawCactus(ctx, obstacle);
    }
  }

  _drawCactus(ctx, cactus) {
    const x = Math.round(cactus.x ?? cactus.bounds?.x ?? 0);
    const y = Math.round(cactus.y ?? cactus.bounds?.y ?? 0);
    const width = Math.max(1, Math.round(cactus.width ?? cactus.bounds?.width ?? 20));
    const height = Math.max(1, Math.round(cactus.height ?? cactus.bounds?.height ?? 36));
    const color = this.config.ink;
    const variant = cactus.variant ?? "small";
    const stemWidth = Math.max(5, Math.round(width * (variant === "wide" ? 0.25 : 0.32)));
    const stemX = Math.round(x + (width - stemWidth) / 2);

    ctx.fillStyle = color;
    ctx.fillRect(stemX, y, stemWidth, height);
    const armY = Math.round(y + height * 0.45);
    const armHeight = Math.max(4, Math.round(height * 0.13));
    const armWidth = Math.max(5, Math.round(width * 0.35));
    ctx.fillRect(x, armY, armWidth, armHeight);
    ctx.fillRect(x, armY - armHeight * 2, Math.max(3, Math.round(armWidth * 0.45)), armHeight * 2);
    ctx.fillRect(x + width - armWidth, Math.round(y + height * 0.62), armWidth, armHeight);
    ctx.fillRect(x + width - Math.max(3, Math.round(armWidth * 0.45)), Math.round(y + height * 0.62) - armHeight * 2, Math.max(3, Math.round(armWidth * 0.45)), armHeight * 2);
  }

  _drawPterodactyl(ctx, bird) {
    const x = Math.round(bird.x ?? bird.bounds?.x ?? 0);
    const y = Math.round(bird.y ?? bird.bounds?.y ?? 0);
    const width = Math.max(1, Math.round(bird.width ?? bird.bounds?.width ?? 46));
    const height = Math.max(1, Math.round(bird.height ?? bird.bounds?.height ?? 26));
    const sx = width / 46;
    const sy = height / 26;
    const px = (left, top, w, h) => this.context.fillRect(
      Math.round(x + left * sx), Math.round(y + top * sy),
      Math.max(1, Math.round(w * sx)), Math.max(1, Math.round(h * sy)),
    );
    const frame = Math.max(0, Math.floor(bird.animation?.frame ?? 0));
    this.context.fillStyle = this.config.ink;
    px(7, 10, 25, 8); // body
    px(28, 8, 10, 7); // head
    px(36, 10, 9, 3); // beak
    px(11, 9, 3, 3);
    if (frame % 2 === 0) {
      px(11, 1, 7, 10);
      px(17, 4, 9, 6);
      px(19, 18, 7, 7);
      px(24, 18, 9, 4);
    } else {
      px(11, 15, 7, 10);
      px(17, 14, 9, 6);
      px(19, 2, 7, 7);
      px(24, 4, 9, 4);
    }
    this.context.fillStyle = "#f7f7f7";
    px(31, 9, 2, 2);
  }

  _drawHud(ctx, snapshot) {
    const score = Math.max(0, Math.floor(finiteOr(snapshot.score, 0)));
    const highScore = Math.max(0, Math.floor(finiteOr(snapshot.highScore, 0)));
    ctx.fillStyle = this.config.ink;
    ctx.textAlign = this.touchMode ? "center" : "right";
    ctx.textBaseline = "top";
    ctx.font = `bold ${this._responsiveFontSize(16)}px monospace`;
    ctx.fillText(`HI ${formatScore(highScore)}   ${formatScore(score)}`, this.touchMode ? this.config.logicalWidth / 2 : this.config.logicalWidth - 24, 18);
  }

  // Keep canvas text legible in CSS pixels while retaining the fixed logical world.
  _responsiveFontSize(cssPixels) {
    if (!this.touchMode && this.viewportWidth >= this.config.logicalWidth) return cssPixels;
    return Math.round(cssPixels * Math.max(1, this.config.logicalWidth / Math.max(1, this.viewportWidth)));
  }

  _drawGameMessage(ctx, state, groundY = this.config.groundY) {
    ctx.fillStyle = this.config.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const screenGroundY = this.cameraOffsetY + groundY;
    const primaryY = Math.max(66, Math.min(this.visibleLogicalHeight * 0.43, screenGroundY - 86));
    const secondaryY = Math.max(primaryY + 24, Math.min(this.visibleLogicalHeight * 0.49, screenGroundY - 58));

    if (state === GAME_STATES.READY) {
      ctx.font = `bold ${this._responsiveFontSize(this.touchMode ? 12 : 16)}px monospace`;
      ctx.fillText(this.touchMode ? "TAP TO START + JUMP" : "PRESS SPACE / ↑ TO START", this.config.logicalWidth / 2, primaryY);
      ctx.font = `${this._responsiveFontSize(this.touchMode ? 10 : 12)}px monospace`;
      ctx.fillText(this.touchMode ? "TAP ANYWHERE TO JUMP" : "SPACE / ↑ TO JUMP", this.config.logicalWidth / 2, secondaryY);
    } else if (state === GAME_STATES.GAME_OVER) {
      ctx.font = `bold ${this._responsiveFontSize(20)}px monospace`;
      ctx.fillText("GAME OVER", this.config.logicalWidth / 2, primaryY);
      ctx.font = `${this._responsiveFontSize(this.touchMode ? 11 : 13)}px monospace`;
      ctx.fillText(this.touchMode ? "TAP TO RESTART" : "PRESS SPACE OR TAP TO PLAY AGAIN", this.config.logicalWidth / 2, secondaryY);
    } else if (state === GAME_STATES.PAUSED) {
      ctx.font = `bold ${this._responsiveFontSize(18)}px monospace`;
      ctx.fillText("PAUSED", this.config.logicalWidth / 2, (primaryY + secondaryY) / 2);
    }
  }

  _drawFinalScene(ctx, snapshot, dinosaur, groundY, elapsedTime) {
    const sceneTime = Math.max(0, finiteOr(snapshot.finalScene?.elapsedTime, elapsedTime));
    const primary = dinosaur ?? {
      state: DINO_STATES.STOPPED,
      bounds: { x: 115, y: groundY - 48, width: 44, height: 48 },
      animation: { frame: 0 },
    };
    const rawScale = this.touchMode
      ? Math.max(1, Math.min(2.2, 32 * this.config.logicalWidth / Math.max(1, this.viewportWidth) / 44))
      : 1;
    const availableSky = this.cameraOffsetY + groundY - 94;
    const maxScaleForText = Math.max(1, availableSky / 68);
    const sceneScale = Math.min(rawScale, maxScaleForText);
    const sceneWidth = 44 * sceneScale;
    const sceneHeight = 48 * sceneScale;
    this._drawFinalPrimaryReaction(ctx, primary, groundY, sceneTime, sceneScale, sceneWidth, sceneHeight);

    // These are the only two supporting dinosaurs; all motion is presentation time.
    const approach = clamp(sceneTime / 2, 0, 1);
    const pairCenter = this.config.logicalWidth * 0.66;
    const closedLeftX = pairCenter - sceneWidth;
    const closedRightX = closedLeftX + sceneWidth - 1;
    const openGap = sceneWidth * 0.9 * (1 - approach);
    const leftX = Math.round(closedLeftX - openGap / 2);
    const rightX = Math.round(closedRightX + openGap / 2);
    const supportBounds = { y: groundY - sceneHeight, width: sceneWidth, height: sceneHeight };
    this._drawDinosaur(ctx, {}, { bounds: { ...supportBounds, x: leftX }, frame: Math.floor(sceneTime * 5) % 2, palette: this.config.secondaryInk });
    this._drawDinosaur(ctx, {}, { bounds: { ...supportBounds, x: rightX }, frame: Math.floor(sceneTime * 5 + 1) % 2, palette: this.config.secondaryInk, facing: "left" });
    this._drawHugArms(ctx, leftX, rightX, groundY, approach, sceneScale);

    if (sceneTime > 1.6) {
      const flowerSize = sceneScale;
      const handoffProgress = easeInOut(clamp((sceneTime - 1.6) / 1.1, 0, 1));
      const startFlowerX = leftX + 33 * sceneScale;
      const targetFlowerX = (leftX + rightX + sceneWidth) / 2 - 5 * flowerSize;
      const flowerX = Math.round(startFlowerX + (targetFlowerX - startFlowerX) * handoffProgress);
      const flowerY = Math.round(groundY - 35 * flowerSize - Math.sin(sceneTime * 4) * 2 * flowerSize);
      this._drawFlower(ctx, flowerX, flowerY, flowerSize);
    }
    if (sceneTime > 4.1) {
      const pulse = Math.floor(sceneTime * 3) % 2;
      ctx.fillStyle = pulse ? this.config.accent : this.config.secondaryInk;
      ctx.font = `bold ${this._responsiveFontSize(16)}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("♥", Math.round((leftX + rightX + sceneWidth) / 2), groundY - 65 * sceneScale);
    }

    this._withScreenTransform(() => {
      this._drawFinalSceneText(ctx, groundY, sceneScale);
    });

    const fadeDuration = 0.45;
    if (sceneTime < fadeDuration) {
      this._withScreenTransform(() => {
        ctx.fillStyle = this.config.background;
        ctx.globalAlpha = 1 - clamp(sceneTime / fadeDuration, 0, 1);
        ctx.fillRect(0, 0, this.config.logicalWidth, this.visibleLogicalHeight);
        ctx.globalAlpha = 1;
      });
    }
  }

  _drawFinalSceneText(ctx, groundY, sceneScale) {
    const maxTextWidth = this.config.logicalWidth - 48;
    const isCompactViewport = this.viewportWidth < 600;
    const baseCssSize = isCompactViewport ? 11.5 : 14;
    const fontSize = clamp(this._responsiveFontSize(baseCssSize), 13, 30);
    const lineHeight = Math.round(fontSize * 1.38);

    ctx.fillStyle = this.config.ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const wrappedGroups = FINAL_SCENE_LINES.map((sentence, index) => {
      const weight = index === 0 ? "bold " : "";
      ctx.font = `${weight}${fontSize}px monospace`;
      return {
        font: `${weight}${fontSize}px monospace`,
        lines: this._wrapText(ctx, sentence, maxTextWidth, fontSize),
      };
    });

    const totalLines = wrappedGroups.reduce((sum, group) => sum + group.lines.length, 0);
    const groupGap = Math.round(fontSize * 0.45);
    const totalBlockHeight = totalLines * lineHeight + (wrappedGroups.length - 1) * groupGap;
    const spriteCeilingScreenY = this.cameraOffsetY + groundY - 68 * sceneScale;
    const preferredTop = this.cameraOffsetY > 40
      ? Math.max(18, Math.min(this.cameraOffsetY * 0.42, spriteCeilingScreenY - totalBlockHeight - 16))
      : Math.max(14, Math.min(24, spriteCeilingScreenY - totalBlockHeight - 10));

    let currentY = Math.round(preferredTop);
    for (let groupIndex = 0; groupIndex < wrappedGroups.length; groupIndex += 1) {
      const group = wrappedGroups[groupIndex];
      ctx.font = group.font;
      for (const line of group.lines) {
        ctx.fillText(line, this.config.logicalWidth / 2, currentY);
        currentY += lineHeight;
      }
      currentY += groupGap;
    }
  }

  _wrapText(ctx, text, maxWidth, fontSize) {
    if (this._measureTextWidth(ctx, text, fontSize) <= maxWidth) {
      return [text];
    }
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let currentLine = "";

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (currentLine && this._measureTextWidth(ctx, candidate, fontSize) > maxWidth) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine) lines.push(currentLine);
    return lines.length > 0 ? lines : [text];
  }

  _measureTextWidth(ctx, text, fontSize) {
    if (typeof ctx.measureText === "function") {
      try {
        const measured = ctx.measureText(text)?.width;
        if (Number.isFinite(measured) && measured > 0) return measured;
      } catch {
        // Fallback to deterministic character width calculation below.
      }
    }
    return Array.from(String(text)).length * fontSize * 0.6;
  }

  /** Main Dino reaction is presentation-only and starts on the Final Scene clock. */
  _drawFinalPrimaryReaction(ctx, primary, groundY, sceneTime, scale, width, height) {
    const bounds = { ...(primary.bounds ?? {}), x: 120, y: groundY - height, width, height };
    const state = DINO_STATES.STOPPED;
    const timing = FINAL_REACTION_TIMING;
    const lookEnd = timing.lookStart + timing.lookDuration;
    const shockEnd = lookEnd + timing.shockDuration;
    const lookBackEnd = shockEnd + timing.lookBackDuration;
    const stumbleEnd = lookBackEnd + timing.stumbleDuration;
    const fallEnd = stumbleEnd + timing.fallDuration;
    const phase = this.getFinalReactionPhase(sceneTime);

    if (phase === FinalReactionPhase.INTRO) {
      this._drawDinosaur(ctx, primary, { bounds, state, frame: 0, reaction: { eyeOffset: -1 } });
      return;
    }
    if (phase === FinalReactionPhase.NOTICE) {
      this._drawDinosaur(ctx, primary, { bounds, state, frame: 0, reaction: { eyeOffset: 1 } });
      return;
    }
    if (phase === FinalReactionPhase.SHOCK) {
      const progress = (sceneTime - lookEnd) / timing.shockDuration;
      this._drawDinosaur(ctx, primary, { bounds, state, frame: 0, reaction: { eyeOffset: 1, surprised: true } });
      this._drawReactionMark(ctx, bounds, scale, progress);
      return;
    }
    if (phase === FinalReactionPhase.LOOK_BACK) {
      const progress = (sceneTime - shockEnd) / timing.lookBackDuration;
      // A brief turn away, then a clear second look toward the pair.
      const turnsAway = progress < 0.34;
      this._drawDinosaur(ctx, primary, {
        bounds,
        state,
        frame: 0,
        facing: turnsAway ? "left" : undefined,
        reaction: { eyeOffset: turnsAway ? 0 : 1, surprised: !turnsAway },
      });
      return;
    }

    const centerX = bounds.x + 22 * scale;
    if (phase === FinalReactionPhase.WOBBLE) {
      const progress = (sceneTime - lookBackEnd) / timing.stumbleDuration;
      const angle = Math.sin(progress * Math.PI * 2) * 0.12 + progress * 0.14;
      const sway = Math.sin(progress * Math.PI * 2) * 3 * scale;
      this._drawRotatedStandingDino(ctx, centerX + sway, groundY, scale, angle, 1, 1, { eyeOffset: 1, surprised: true });
      return;
    }

    const fallProgress = clamp((sceneTime - stumbleEnd) / timing.fallDuration, 0, 1);
    const easedFall = easeInOut(fallProgress);
    const angle = 0.14 + (Math.PI / 2 - 0.14) * easedFall;
    const horizontalSquash = 1 - 0.6 * easedFall;
    const verticalStretch = 1 + 0.35 * easedFall;
    // At and after fallEnd the eased values settle to the same final resting pose.
    if (sceneTime >= fallEnd || phase === FinalReactionPhase.REST) {
      this._drawRotatedStandingDino(ctx, centerX, groundY, scale, Math.PI / 2, 0.4, 1.35, { eyeOffset: 0, surprised: true });
      return;
    }
    this._drawRotatedStandingDino(ctx, centerX, groundY, scale, angle, horizontalSquash, verticalStretch, { eyeOffset: 1, surprised: true });
  }

  _drawRotatedStandingDino(ctx, centerX, groundY, scale, angle, horizontalScale, verticalScale, reaction = null) {
    const cosine = Math.abs(Math.cos(angle));
    const sine = Math.abs(Math.sin(angle));
    const halfHeight = (sine * 44 * horizontalScale + cosine * 48 * verticalScale) * scale / 2;
    ctx.save();
    ctx.translate(centerX, groundY - halfHeight);
    ctx.rotate(angle);
    ctx.scale(scale * horizontalScale, scale * verticalScale);
    this._drawStandingDino(ctx, -22, -24, 44, 48, 0, this.config.ink, false, null, reaction);
    ctx.restore();
  }

  _drawReactionMark(ctx, bounds, scale, progress) {
    const bounce = Math.round(Math.sin(progress * Math.PI * 5) * 2 * scale);
    const x = Math.round(bounds.x + 40 * scale);
    const y = Math.round(bounds.y - 10 * scale + bounce);
    ctx.fillStyle = this.config.ink;
    ctx.fillRect(x, y, Math.max(1, Math.round(3 * scale)), Math.max(2, Math.round(7 * scale)));
    ctx.fillRect(x, y + Math.round(10 * scale), Math.max(1, Math.round(3 * scale)), Math.max(1, Math.round(3 * scale)));
  }

  _drawFinalTransition(ctx, snapshot) {
    const duration = Math.max(0.001, finiteOr(snapshot.finalTransition?.duration, 0.8));
    const elapsed = Math.max(0, finiteOr(snapshot.finalTransition?.elapsedTime, 0));
    ctx.fillStyle = this.config.background;
    ctx.globalAlpha = clamp(elapsed / duration, 0, 1);
    ctx.fillRect(0, 0, this.config.logicalWidth, this.visibleLogicalHeight);
    ctx.globalAlpha = 1;
  }

  _drawFlower(ctx, x, y, scale = 1) {
    const pixel = (px, py, width, height) => ctx.fillRect(
      Math.round(x + px * scale), Math.round(y + py * scale),
      Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)),
    );
    ctx.fillStyle = this.config.accent;
    pixel(3, 0, 4, 4);
    pixel(0, 3, 4, 4);
    pixel(6, 3, 4, 4);
    pixel(3, 6, 4, 4);
    ctx.fillStyle = "#e7c85b";
    pixel(3, 3, 4, 4);
    ctx.fillStyle = "#5d8055";
    pixel(4, 10, 2, 10);
    pixel(0, 14, 5, 2);
  }

  _drawHugArms(ctx, leftX, rightX, groundY, approach, sceneScale = 1) {
    if (approach < 0.75) return;
    const blend = clamp((approach - 0.75) / 0.25, 0, 1);
    const scale = Math.max(0.5, finiteOr(sceneScale, (rightX - leftX) / 44));
    const armY = Math.round(groundY - 25 * scale);
    const innerLeft = Math.round(leftX + 31 * scale);
    const innerRight = Math.round(rightX + 12 * scale);
    const span = Math.max(1, Math.round((innerRight - innerLeft) * blend));
    ctx.fillStyle = this.config.secondaryInk;
    // Two offset arms meet across the small gap, with short elbows suggesting an embrace.
    const unit = Math.max(1, Math.round(scale));
    ctx.fillRect(innerLeft, armY, span, 3 * unit);
    ctx.fillRect(innerLeft + 3 * unit, armY + 4 * unit, Math.max(1, span - 3 * unit), 3 * unit);
    ctx.fillRect(innerLeft, armY - 2 * unit, 3 * unit, 5 * unit);
    ctx.fillRect(innerRight - 3 * unit, armY + 2 * unit, 3 * unit, 5 * unit);
  }
}

function normalizeDinosaur(value) {
  if (!value || typeof value !== "object") return null;
  // A Dinosaur.getSnapshot() already includes renderer-ready bounds/frame data.
  return {
    ...value,
    bounds: value.bounds ?? {
      x: value.x ?? 40,
      y: value.y ?? 0,
      width: value.width ?? 44,
      height: value.height ?? 48,
    },
    animation: value.animation ?? { name: value.state ?? DINO_STATES.RUNNING, frame: 0, frameCount: 1 },
  };
}

function normalizeObstacles(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.obstacles)) return value.obstacles;
  return [];
}

function positiveOr(...values) {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function easeInOut(value) {
  const progress = clamp(value, 0, 1);
  return progress * progress * (3 - 2 * progress);
}

function wrap(value, min, max) {
  const span = max - min;
  return ((value - min) % span + span) % span + min;
}

function formatScore(value) {
  return String(value).padStart(5, "0");
}

function detectTouchMode() {
  try {
    if (typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(any-pointer: coarse)").matches) return true;
  } catch { /* Use the touch-point fallback where matchMedia is unavailable. */ }
  return Number(globalThis.navigator?.maxTouchPoints ?? 0) > 0;
}

export default Renderer;