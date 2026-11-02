import Dinosaur from "./dinosaur.js";
import Obstacles from "./obstacles.js";

export const GameState = Object.freeze({
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

const DEFAULT_CONFIG = Object.freeze({
  groundY: 180,
  worldWidth: 900,
  maxDeltaTime: 0.05,
  initialSpeed: 280,
  maxSpeed: 460,
  speedIncreasePerSecond: 0.55,
  scoreRate: 10,
  scoreMilestone: 100,
  finalApproachScore: 250,
  finalSceneScore: 300,
  finalRunOutDuration: 0.45,
  finalStopHoldDuration: 0.45,
  finalDeceleration: 360,
  finalTransitionDuration: 0.8,
  gameOverAnimationDuration: 0.3,
  highScoreStorageKey: "vanhcodes-dino-high-score",
});

const TOUCH_DEDUPE_MS = 80;

/**
 * Coordinates the player, obstacles, renderer, and audio without owning their
 * rendering or character physics.
 *
 * @example
 * const game = new Game({ renderer, audio });
 * game.start(); // Starts the requestAnimationFrame loop in the ready state.
 */
export class Game {
  constructor(options = {}) {
    const {
      renderer,
      audio = null,
      canvas = renderer?.canvas ?? null,
      dinosaur = null,
      obstacleSystem = null,
      dinosaurOptions = {},
      obstacleOptions = {},
      config = {},
      storage,
      keyboardTarget = globalThis.window ?? globalThis.document ?? null,
      documentRef = globalThis.document ?? null,
      requestAnimationFrame = globalThis.requestAnimationFrame?.bind(globalThis) ?? null,
      cancelAnimationFrame = globalThis.cancelAnimationFrame?.bind(globalThis) ?? null,
    } = options;

    if (!renderer || typeof renderer.render !== "function") {
      throw new TypeError("Game requires a renderer with a render(snapshot) method.");
    }

    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    this._validateConfig();
    this.renderer = renderer;
    this.audio = audio;
    this.canvas = canvas;
    this.keyboardTarget = keyboardTarget;
    this.documentRef = documentRef;
    this.requestAnimationFrame = requestAnimationFrame;
    this.cancelAnimationFrame = cancelAnimationFrame;
    this.storage = storage === undefined ? getBrowserStorage() : storage;

    this.dinosaur = dinosaur ?? new Dinosaur({
      ...dinosaurOptions,
      groundY: this.config.groundY,
    });
    this.obstacles = obstacleSystem ?? new Obstacles({
      ...obstacleOptions,
      groundY: this.config.groundY,
      screenWidth: this.config.worldWidth,
    });

    this.state = GameState.READY;
    this.stateBeforePause = GameState.READY;
    this.score = 0;
    this.highScore = this._readHighScore();
    this.elapsedTime = 0;
    this.finalSceneElapsed = 0;
    this.finalStopElapsed = 0;
    this.finalTransitionElapsed = 0;
    this.finalStopPhase = "runout";
    this.gameOverElapsed = 0;
    this.worldOffset = 0;
    this.speed = this.config.initialSpeed;
    this.nextScoreMilestone = this.config.scoreMilestone;
    this.finalObstacleId = null;
    this.finalObstaclePassed = false;

    this.loopActive = false;
    this.frameRequestId = null;
    this.lastTimestamp = null;
    this.destroyed = false;
    this.listenersAttached = false;
    this.visibilityPaused = false;
    this.pressedKeys = new Set();
    this.lastPointerDownTime = -Infinity;
    this.audioUnlocked = false;
    this.audioUnlockPending = false;
    this.pendingAudioMethods = [];

    this._onAnimationFrame = this._onAnimationFrame.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onWindowBlur = this._onWindowBlur.bind(this);
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);

    this._attachListeners();
  }

  /** Start drawing in the ready state. This does not begin a gameplay round. */
  start() {
    if (this.destroyed) return false;
    this._render();
    if (this.loopActive) return true;
    if (typeof this.requestAnimationFrame !== "function") return false;
    this.loopActive = true;
    this.lastTimestamp = null;
    this._scheduleFrame();
    return true;
  }

  /** Start a fresh round without changing the saved high score. */
  restart() {
    return this._beginRound();
  }

  pause() {
    if (this.destroyed || this.state === GameState.PAUSED || this.state === GameState.GAME_OVER) return false;
    this.stateBeforePause = this.state;
    this.state = GameState.PAUSED;
    this._releaseAllInputs();
    this._persistHighScore();
    this._stopLoop();
    this._render();
    return true;
  }

  resume() {
    if (this.destroyed || this.state !== GameState.PAUSED) return false;
    this.state = this.stateBeforePause;
    this.lastTimestamp = null;
    this._render();
    if (typeof this.requestAnimationFrame === "function") {
      this.loopActive = true;
      this._scheduleFrame();
    }
    return true;
  }

  /**
   * Handle abstract inputs from keyboard, pointer, or custom controls.
   * Actions: start and jump. Pointer input is a single action per pointerdown.
   */
  handleInput(action, pressed = true) {
    if (this.destroyed) return false;
    const normalized = normalizeAction(action);
    if (!normalized) return false;
    if (!pressed) return false;

    this._unlockAudioFromInput();
    if (this.state === GameState.PAUSED) {
      if (normalized === "start" || normalized === "jump") return this.resume();
      return false;
    }
    if (this.state === GameState.READY) {
      this._beginRound();
      if (normalized === "jump" && this.dinosaur.jump()) {
        this._playSound("playJump");
        this._render();
      } else {
        this._playSound("playUI");
      }
      return true;
    }
    if (this.state === GameState.GAME_OVER || this.state === GameState.FINAL_SCENE) {
      this._beginRound();
      this._playSound("playUI");
      return true;
    }
    if (
      (
        this.state === GameState.RUNNING ||
        this.state === GameState.FINAL_APPROACH ||
        this.state === GameState.FINAL_RUNOUT
      ) &&
      normalized === "jump"
    ) {
      if (!this.dinosaur.jump()) return false;
      this._playSound("playJump");
      return true;
    }
    return false;
  }

  getState() {
    return this.state;
  }

  /** Renderer-ready detached snapshot. */
  getSnapshot() {
    return {
      state: this.state,
      score: this.score,
      highScore: this.highScore,
      elapsedTime: this.elapsedTime,
      finalScene: { elapsedTime: this.finalSceneElapsed },
      finalTransition: {
        elapsedTime: this.finalTransitionElapsed,
        duration: this.config.finalTransitionDuration,
      },
      speed: this.speed,
      worldOffset: this.worldOffset,
      groundY: this.config.groundY,
      dinosaur: this.dinosaur.getSnapshot(),
      obstacles: this.obstacles.getObstacles(),
      ui: {
        canStart: this.state === GameState.READY,
        canRestart: this.state === GameState.GAME_OVER || this.state === GameState.FINAL_SCENE,
        paused: this.state === GameState.PAUSED,
      },
    };
  }

  /** Remove input listeners, stop scheduling, and release owned audio resources. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._persistHighScore();
    this._stopLoop();
    this._detachListeners();
    this._releaseAllInputs();
    this.pendingAudioMethods.length = 0;
    try { this.audio?.dispose?.(); } catch { /* Audio cleanup must not block game teardown. */ }
  }

  _beginRound() {
    if (this.destroyed) return false;
    if (this.score > 0) this._persistHighScore();
    this.dinosaur.reset({ x: this.dinosaur.config?.x ?? 40, groundY: this.config.groundY });
    this.obstacles.reset();
    this.state = GameState.RUNNING;
    this.score = 0;
    this.elapsedTime = 0;
    this.finalSceneElapsed = 0;
    this.finalStopElapsed = 0;
    this.finalTransitionElapsed = 0;
    this.finalStopPhase = "runout";
    this.gameOverElapsed = 0;
    this.worldOffset = 0;
    this.speed = this.config.initialSpeed;
    this.nextScoreMilestone = this.config.scoreMilestone;
    this.finalObstacleId = null;
    this.finalObstaclePassed = false;
    this.lastTimestamp = null;
    this._releaseAllInputs();
    this._startLoopIfNeeded();
    this._render();
    return true;
  }

  _startLoopIfNeeded() {
    if (this.loopActive || typeof this.requestAnimationFrame !== "function" || this.destroyed) return;
    this.loopActive = true;
    this.lastTimestamp = null;
    this._scheduleFrame();
  }

  _scheduleFrame() {
    if (!this.loopActive || this.frameRequestId !== null || this.destroyed) return;
    try {
      this.frameRequestId = this.requestAnimationFrame(this._onAnimationFrame);
    } catch {
      this.loopActive = false;
      this.frameRequestId = null;
    }
  }

  _onAnimationFrame(timestamp) {
    this.frameRequestId = null;
    if (!this.loopActive || this.destroyed) return;

    const safeTimestamp = Number.isFinite(timestamp) ? timestamp : 0;
    const deltaTime = this.lastTimestamp === null
      ? 0
      : Math.min(this.config.maxDeltaTime, Math.max(0, (safeTimestamp - this.lastTimestamp) / 1000));
    this.lastTimestamp = safeTimestamp;

    this._update(deltaTime);
    this._render();

    if (this.state === GameState.GAME_OVER && this.gameOverElapsed >= this.config.gameOverAnimationDuration) {
      this._stopLoop();
    } else {
      this._scheduleFrame();
    }
  }

  _update(deltaTime) {
    if (this.state === GameState.RUNNING) {
      this._updateRunning(deltaTime);
    } else if (this.state === GameState.FINAL_APPROACH) {
      this._updateFinalApproach(deltaTime);
    } else if (this.state === GameState.FINAL_RUNOUT) {
      this._updateFinalRunOut(deltaTime);
    } else if (this.state === GameState.FINAL_STOP) {
      this._updateFinalStop(deltaTime);
    } else if (this.state === GameState.FINAL_TRANSITION) {
      this.finalTransitionElapsed += deltaTime;
      if (this.finalTransitionElapsed >= this.config.finalTransitionDuration) this._completeFinalTransition();
    } else if (this.state === GameState.FINAL_SCENE) {
      this.finalSceneElapsed += deltaTime;
    } else if (this.state === GameState.GAME_OVER) {
      // Dinosaur.update only advances its dead animation once `die()` has run.
      this.dinosaur.update(deltaTime);
      this.gameOverElapsed += deltaTime;
    }
  }

  _updateRunning(deltaTime) {
    const wasAirborne = this.dinosaur.isAirborne();
    this.dinosaur.update(deltaTime);
    this.obstacles.update(deltaTime, this.speed);
    this.elapsedTime += deltaTime;
    this.worldOffset += this.speed * deltaTime;
    this.score = Math.floor(this.elapsedTime * this.config.scoreRate);

    if (this.score > this.highScore) this.highScore = this.score;
    if (wasAirborne && !this.dinosaur.isAirborne()) this._playSound("playLand");

    this.speed = Math.min(
      this.config.maxSpeed,
      this.config.initialSpeed + this.elapsedTime * this.config.speedIncreasePerSecond,
    );

    while (this.score >= this.nextScoreMilestone) {
      this._playSound("playScore");
      this.nextScoreMilestone += this.config.scoreMilestone;
    }

    if (this.config.finalSceneScore !== null && this.score >= this.config.finalApproachScore) {
      this._enterFinalApproach();
    }

    // At the approach threshold, stale random obstacles are cleared before collision checks.
    if (this._hasCollision()) this._endRun();
  }

  _updateFinalApproach(deltaTime) {
    if (!this._updateFinalSequenceMovement(deltaTime)) return;
    const obstacle = this._findFinalObstacle();
    const dinoBounds = this.dinosaur.getBounds();
    if (obstacle && obstacle.x + obstacle.width <= dinoBounds.x) {
      this.finalObstaclePassed = true;
      this.state = GameState.FINAL_RUNOUT;
    }
  }

  _updateFinalRunOut(deltaTime) {
    if (!this._updateFinalSequenceMovement(deltaTime)) return;
    // The cactus must both pass the player and leave the visible world.
    if (this.finalObstaclePassed && !this._findFinalObstacle()) {
      this.state = GameState.FINAL_STOP;
      this.finalStopPhase = "runout";
      this.finalStopElapsed = 0;
    }
  }

  _updateFinalSequenceMovement(deltaTime) {
    const wasAirborne = this.dinosaur.isAirborne();
    this.dinosaur.update(deltaTime);
    this.obstacles.update(deltaTime, Math.max(0, this.speed), { allowSpawn: false });
    this.elapsedTime += deltaTime;
    this.worldOffset += this.speed * deltaTime;
    this.score = Math.floor(this.elapsedTime * this.config.scoreRate);

    if (this.score > this.highScore) this.highScore = this.score;
    if (wasAirborne && !this.dinosaur.isAirborne()) this._playSound("playLand");

    if (this._hasCollision()) {
      this._endRun();
      return false;
    }

    while (this.score >= this.nextScoreMilestone) {
      this._playSound("playScore");
      this.nextScoreMilestone += this.config.scoreMilestone;
    }
    return true;
  }

  _updateFinalStop(deltaTime) {
    if (this.finalStopPhase === "runout") {
      this._updateFinalSequenceMovement(deltaTime);
      if (this.state !== GameState.FINAL_STOP) return;
      this.finalStopElapsed += deltaTime;
      if (this.finalStopElapsed >= this.config.finalRunOutDuration && !this.dinosaur.isAirborne()) {
        this.finalStopPhase = "decelerating";
        this.finalStopElapsed = 0;
      }
      return;
    }

    if (this.finalStopPhase === "decelerating") {
      const wasAirborne = this.dinosaur.isAirborne();
      this.dinosaur.update(deltaTime);
      const nextSpeed = Math.max(0, this.speed - this.config.finalDeceleration * deltaTime);
      const averageSpeed = (this.speed + nextSpeed) / 2;
      this.obstacles.update(deltaTime, averageSpeed, { allowSpawn: false });
      this.elapsedTime += deltaTime;
      this.worldOffset += averageSpeed * deltaTime;
      this.score = Math.floor(this.elapsedTime * this.config.scoreRate);
      if (this.score > this.highScore) this.highScore = this.score;
      if (wasAirborne && !this.dinosaur.isAirborne()) this._playSound("playLand");
      while (this.score >= this.nextScoreMilestone) {
        this._playSound("playScore");
        this.nextScoreMilestone += this.config.scoreMilestone;
      }
      this.speed = nextSpeed;
      if (this.speed === 0) {
        if (this.dinosaur.isAirborne()) this.finalStopPhase = "settling";
        else this._beginFinalStopHold();
      }
      return;
    }

    if (this.finalStopPhase === "settling") {
      const wasAirborne = this.dinosaur.isAirborne();
      this.dinosaur.update(deltaTime);
      this.elapsedTime += deltaTime;
      this.score = Math.floor(this.elapsedTime * this.config.scoreRate);
      if (this.score > this.highScore) this.highScore = this.score;
      if (wasAirborne && !this.dinosaur.isAirborne()) this._playSound("playLand");
      while (this.score >= this.nextScoreMilestone) {
        this._playSound("playScore");
        this.nextScoreMilestone += this.config.scoreMilestone;
      }
      if (!this.dinosaur.isAirborne()) this._beginFinalStopHold();
      return;
    }

    if (this.finalStopPhase === "holding") {
      this.finalStopElapsed += deltaTime;
      if (this.finalStopElapsed >= this.config.finalStopHoldDuration) this._beginFinalSceneTransition();
    }
  }

  _beginFinalStopHold() {
    if (!this.dinosaur.stop()) return;
    this.finalStopPhase = "holding";
    this.finalStopElapsed = 0;
  }

  _hasCollision() {
    const dino = this.dinosaur.getHitbox();
    for (const obstacle of this.obstacles.getHitboxes()) {
      if (intersects(dino, obstacle)) return true;
    }
    return false;
  }

  _endRun() {
    if (![GameState.RUNNING, GameState.FINAL_APPROACH, GameState.FINAL_RUNOUT].includes(this.state)) return;
    this.dinosaur.die();
    this.state = GameState.GAME_OVER;
    this.gameOverElapsed = 0;
    this._releaseAllInputs();
    this._persistHighScore();
    this._playSound("playCollision");
  }

  _findFinalObstacle() {
    if (!this.finalObstacleId) return null;
    const obstacles = this.obstacles.getObstacles();
    return obstacles.find((obstacle) => obstacle.id === this.finalObstacleId) ?? null;
  }

  _enterFinalApproach() {
    if (this.state !== GameState.RUNNING) return;
    this.state = GameState.FINAL_APPROACH;
    this.finalObstaclePassed = false;
    this.obstacles.clear?.();
    this.finalObstacleId = this.obstacles.spawnFinalObstacle({ x: this.config.worldWidth + 120, groundY: this.config.groundY });
    this._releaseAllInputs();
    this._playSound("playUI");
  }

  _beginFinalSceneTransition() {
    if (
      this.state !== GameState.FINAL_STOP ||
      this.finalStopPhase !== "holding" ||
      !this.finalObstaclePassed ||
      this.speed !== 0 ||
      this.dinosaur.state !== "stopped" ||
      this._findFinalObstacle()
    ) return;
    this.state = GameState.FINAL_TRANSITION;
    this.finalTransitionElapsed = 0;
  }

  _completeFinalTransition() {
    if (
      this.state !== GameState.FINAL_TRANSITION ||
      this.finalTransitionElapsed < this.config.finalTransitionDuration ||
      !this.finalObstaclePassed ||
      this.dinosaur.state !== "stopped" ||
      this.speed !== 0 ||
      this._findFinalObstacle()
    ) return;
    this.state = GameState.FINAL_SCENE;
    this.finalSceneElapsed = 0;
    this.speed = 0;
    this._releaseAllInputs();
    this._persistHighScore();
    this._playSound("playFinalScene");
  }

  _render() {
    if (this.destroyed) return;
    this.renderer.render(this.getSnapshot());
  }

  _attachListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    this.keyboardTarget?.addEventListener?.("keydown", this._onKeyDown);
    this.keyboardTarget?.addEventListener?.("keyup", this._onKeyUp);
    this.keyboardTarget?.addEventListener?.("blur", this._onWindowBlur);
    this.documentRef?.addEventListener?.("visibilitychange", this._onVisibilityChange);
    this.canvas?.addEventListener?.("pointerdown", this._onPointerDown, { passive: false });
    this.canvas?.addEventListener?.("touchstart", this._onTouchStart, { passive: false });
  }

  _detachListeners() {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;
    this.keyboardTarget?.removeEventListener?.("keydown", this._onKeyDown);
    this.keyboardTarget?.removeEventListener?.("keyup", this._onKeyUp);
    this.keyboardTarget?.removeEventListener?.("blur", this._onWindowBlur);
    this.documentRef?.removeEventListener?.("visibilitychange", this._onVisibilityChange);
    this.canvas?.removeEventListener?.("pointerdown", this._onPointerDown);
    this.canvas?.removeEventListener?.("touchstart", this._onTouchStart);
  }

  _onKeyDown(event) {
    const key = event.code === "Space" || event.key === " "
      ? "Space"
      : event.key === "ArrowUp"
        ? "ArrowUp"
        : null;
    if (!key) return;
    event.preventDefault?.();
    if (event.repeat || this.pressedKeys.has(key)) return;
    this.pressedKeys.add(key);
    this.handleInput("jump");
  }

  _onKeyUp(event) {
    if (event.code === "Space" || event.key === " ") this.pressedKeys.delete("Space");
    if (event.key === "ArrowUp") this.pressedKeys.delete("ArrowUp");
  }

  _onWindowBlur() {
    this._releaseAllInputs();
  }

  _onVisibilityChange() {
    if (this.documentRef?.visibilityState === "hidden") {
      this.visibilityPaused = this.pause();
    } else if (this.visibilityPaused) {
      this.visibilityPaused = false;
      this.resume();
    }
  }

  _onPointerDown(event) {
    if (event.isPrimary === false) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault?.();
    this.lastPointerDownTime = nowMs();
    this.handleInput("jump");
  }

  _onTouchStart(event) {
    if (event.touches && event.touches.length > 1) return;
    event.preventDefault?.();
    const currentTime = nowMs();
    if (currentTime - this.lastPointerDownTime <= TOUCH_DEDUPE_MS) return;
    this.lastPointerDownTime = currentTime;
    this.handleInput("jump");
  }

  _releaseAllInputs() {
    this.pressedKeys.clear();
  }

  _unlockAudioFromInput() {
    if (!this.audio || this.audioUnlocked || this.audioUnlockPending || typeof this.audio.resume !== "function") return;
    this.audioUnlockPending = true;
    let result;
    try {
      result = this.audio.resume();
    } catch {
      this.audioUnlockPending = false;
      return;
    }
    Promise.resolve(result).then((ready) => {
      this.audioUnlockPending = false;
      this.audioUnlocked = Boolean(ready);
      if (!this.audioUnlocked) {
        this.pendingAudioMethods.length = 0;
        return;
      }
      const pending = this.pendingAudioMethods.splice(0);
      for (const method of pending) this._callAudio(method);
    }).catch(() => {
      this.audioUnlockPending = false;
      this.pendingAudioMethods.length = 0;
    });
  }

  _playSound(method) {
    if (!this.audio || typeof this.audio[method] !== "function") return false;
    if (this.audioUnlocked) return this._callAudio(method);
    this.pendingAudioMethods.push(method);
    if (this.pendingAudioMethods.length > 8) this.pendingAudioMethods.shift();
    this._unlockAudioFromInput();
    return true;
  }

  _callAudio(method) {
    try {
      this.audio[method]();
      return true;
    } catch {
      return false;
    }
  }

  _readHighScore() {
    try {
      const stored = Number.parseInt(this.storage?.getItem(this.config.highScoreStorageKey) ?? "0", 10);
      return Number.isFinite(stored) && stored > 0 ? stored : 0;
    } catch {
      return 0;
    }
  }

  _persistHighScore() {
    try {
      this.storage?.setItem(this.config.highScoreStorageKey, String(this.highScore));
    } catch {
      // Storage may be unavailable or quota-restricted; current game remains playable.
    }
  }

  _stopLoop() {
    this.loopActive = false;
    if (this.frameRequestId !== null && typeof this.cancelAnimationFrame === "function") {
      try { this.cancelAnimationFrame(this.frameRequestId); } catch { /* Best effort cancellation. */ }
    }
    this.frameRequestId = null;
    this.lastTimestamp = null;
  }

  _validateConfig() {
    const positive = [
      "worldWidth", "maxDeltaTime", "initialSpeed", "maxSpeed", "scoreRate", "scoreMilestone",
      "finalApproachScore", "finalRunOutDuration", "finalStopHoldDuration", "finalDeceleration",
      "finalTransitionDuration", "gameOverAnimationDuration",
    ];
    for (const key of positive) {
      if (!Number.isFinite(this.config[key]) || this.config[key] <= 0) {
        throw new RangeError(`${key} must be a positive finite number.`);
      }
    }
    if (!Number.isFinite(this.config.groundY) || this.config.groundY < 0) {
      throw new RangeError("groundY must be a finite non-negative number.");
    }
    if (!Number.isFinite(this.config.speedIncreasePerSecond) || this.config.speedIncreasePerSecond < 0) {
      throw new RangeError("speedIncreasePerSecond must be a finite non-negative number.");
    }
    if (this.config.maxSpeed < this.config.initialSpeed) {
      throw new RangeError("maxSpeed must be greater than or equal to initialSpeed.");
    }
    if (this.config.finalSceneScore !== null && (!Number.isFinite(this.config.finalSceneScore) || this.config.finalSceneScore <= 0)) {
      throw new RangeError("finalSceneScore must be null or a positive finite number.");
    }
    if (this.config.finalSceneScore !== null && this.config.finalApproachScore >= this.config.finalSceneScore) {
      throw new RangeError("finalApproachScore must be lower than finalSceneScore.");
    }
    if (typeof this.config.highScoreStorageKey !== "string" || !this.config.highScoreStorageKey) {
      throw new TypeError("highScoreStorageKey must be a non-empty string.");
    }
  }
}

function normalizeAction(action) {
  switch (action) {
    case "start":
    case "restart":
      return "start";
    case "jump":
    case "Space":
    case "ArrowUp":
      return "jump";
    default:
      return null;
  }
}

function intersects(a, b) {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
}

function getBrowserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function nowMs() {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

export default Game;