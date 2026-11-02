/**
 * Player-controlled dinosaur state and physics.
 * Coordinates use a top-left origin with positive Y moving downward. `groundY`
 * is the world-space baseline the dinosaur's feet rest on.
 */

export const DinosaurState = Object.freeze({
  RUNNING: "running",
  JUMPING: "jumping",
  FALLING: "falling",
  STOPPED: "stopped",
  DEAD: "dead",
});

const DEFAULTS = Object.freeze({
  x: 40,
  groundY: 0,
  gravity: 2200,
  jumpHeight: 118,
  standingWidth: 44,
  standingHeight: 48,
  animationFrameDuration: 0.11,
});

// Sprite-frame descriptions are renderer-facing data, not image assets.
const ANIMATION_DATA = Object.freeze({
  [DinosaurState.RUNNING]: Object.freeze({ frameCount: 2, durationMultiplier: 1, loop: true }),
  [DinosaurState.JUMPING]: Object.freeze({ frameCount: 1, durationMultiplier: 1, loop: false }),
  [DinosaurState.FALLING]: Object.freeze({ frameCount: 1, durationMultiplier: 1, loop: false }),
  [DinosaurState.STOPPED]: Object.freeze({ frameCount: 1, durationMultiplier: 1, loop: false }),
  [DinosaurState.DEAD]: Object.freeze({ frameCount: 2, durationMultiplier: 1.27, loop: false }),
});

const HITBOX_INSETS = Object.freeze({
  standing: Object.freeze({ left: 4, right: 4, top: 4, bottom: 2 }),
});

/**
 * @example
 * const dino = new Dinosaur({ x: 48, groundY: 190 });
 * dino.handleInput("ArrowUp");
 * dino.update(deltaSeconds);
 * const { x, y, width, height } = dino.getHitbox();
 */
export class Dinosaur {
  constructor(options = {}) {
    this.config = Object.freeze({ ...DEFAULTS, ...options });
    this._validateConfig();

    this.x = this.config.x;
    this.y = this.config.groundY - this.config.standingHeight;
    this.groundY = this.config.groundY;
    this.velocityY = 0;
    this.state = DinosaurState.RUNNING;
    this.animationTime = 0;
  }

  /** Advance physics and animation by elapsed seconds. */
  update(deltaSeconds) {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    if (this.state === DinosaurState.STOPPED) return;

    this.animationTime += deltaSeconds;
    if (this.state === DinosaurState.DEAD) return;

    if (this.isAirborne()) {
      // Semi-analytic integration avoids frame-rate dependent jump height.
      this.y += this.velocityY * deltaSeconds + 0.5 * this.config.gravity * deltaSeconds ** 2;
      this.velocityY += this.config.gravity * deltaSeconds;

      const feet = this.y + this._bodyHeight();
      if (feet >= this.groundY) {
        this.velocityY = 0;
        this.state = DinosaurState.RUNNING;
        this.y = this.groundY - this.config.standingHeight;
      } else if (this.velocityY > 0) {
        this.state = DinosaurState.FALLING;
      } else {
        this.state = DinosaurState.JUMPING;
      }
      return;
    }

    this.y = this.groundY - this.config.standingHeight;
    this.state = DinosaurState.RUNNING;
  }

  /** Start a jump if grounded. Airborne/dead dinosaurs ignore the request. */
  jump() {
    if (this.state === DinosaurState.DEAD || this.isAirborne()) return false;

    this.state = DinosaurState.JUMPING;
    this.y = this.groundY - this.config.standingHeight;
    // This launch speed reaches exactly jumpHeight under the configured gravity.
    this.velocityY = -Math.sqrt(2 * this.config.gravity * this.config.jumpHeight);
    return true;
  }

  /** Input adapter for game/keyboard/touch controllers; does not access the DOM. */
  handleInput(input, isPressed = true) {
    switch (input) {
      case "Space":
      case "ArrowUp":
      case "jump":
        return isPressed ? this.jump() : false;
      default:
        return false;
    }
  }

  /** Touch/controller friendly jump method. */
  pressJump() {
    return this.jump();
  }

  /** Mark the dinosaur dead; it remains in that state until reset. */
  die() {
    if (this.state === DinosaurState.DEAD) return;
    this.state = DinosaurState.DEAD;
    this.velocityY = 0;
    this.animationTime = 0;
  }

  /** Hold a grounded idle pose after the gameplay runout has fully stopped. */
  stop() {
    if (this.state === DinosaurState.DEAD || this.isAirborne()) return false;
    this.state = DinosaurState.STOPPED;
    this.velocityY = 0;
    this.y = this.groundY - this.config.standingHeight;
    this.animationTime = 0;
    return true;
  }

  /** Restore the initial grounded state, optionally at another baseline. */
  reset({ x = this.config.x, groundY = this.groundY } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(groundY)) {
      throw new TypeError("Dinosaur reset coordinates must be finite numbers.");
    }
    this.x = x;
    this.groundY = groundY;
    this.y = groundY - this.config.standingHeight;
    this.velocityY = 0;
    this.state = DinosaurState.RUNNING;
    this.animationTime = 0;
  }

  isAirborne() {
    return this.state === DinosaurState.JUMPING || this.state === DinosaurState.FALLING;
  }

  /** Renderer-facing frame descriptor; renderer owns all drawing. */
  getAnimation() {
    const data = ANIMATION_DATA[this.state];
    const frameDuration = this.config.animationFrameDuration * data.durationMultiplier;
    const rawFrame = Math.floor(this.animationTime / frameDuration);
    const frame = data.loop ? rawFrame % data.frameCount : Math.min(rawFrame, data.frameCount - 1);
    return { name: this.state, frame, frameCount: data.frameCount, duration: frameDuration };
  }

  /** World-space visual bounds for renderer positioning. */
  getBounds() {
    return { x: this.x, y: this.y, width: this._bodyWidth(), height: this._bodyHeight() };
  }

  /** World-space collision box, trimmed from the visual bounds. */
  getHitbox() {
    const bounds = this.getBounds();
    const inset = HITBOX_INSETS.standing;
    return {
      x: bounds.x + inset.left,
      y: bounds.y + inset.top,
      width: bounds.width - inset.left - inset.right,
      height: bounds.height - inset.top - inset.bottom,
    };
  }

  /** Read-only snapshot convenient for the game and renderer modules. */
  getSnapshot() {
    return {
      state: this.state,
      x: this.x,
      y: this.y,
      velocityY: this.velocityY,
      bounds: this.getBounds(),
      hitbox: this.getHitbox(),
      animation: this.getAnimation(),
    };
  }

  _bodyWidth() {
    return this.config.standingWidth;
  }

  _bodyHeight() {
    return this.config.standingHeight;
  }

  _validateConfig() {
    const positiveKeys = [
      "gravity", "jumpHeight", "standingWidth", "standingHeight",
      "animationFrameDuration",
    ];
    for (const key of positiveKeys) {
      if (!Number.isFinite(this.config[key]) || this.config[key] <= 0) {
        throw new RangeError(`Dinosaur option ${key} must be a positive finite number.`);
      }
    }
    if (!Number.isFinite(this.config.x) || !Number.isFinite(this.config.groundY)) {
      throw new TypeError("Dinosaur x and groundY must be finite numbers.");
    }
  }
}

export default Dinosaur;

