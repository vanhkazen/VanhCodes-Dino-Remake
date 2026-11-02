/** Obstacle data, spawning, movement, and collision bounds for gameplay. */

export const ObstacleType = Object.freeze({
  CACTUS: "cactus",
  PTERODACTYL: "pterodactyl",
});

const DEFAULT_CONFIG = Object.freeze({
  screenWidth: 900,
  groundY: 180,
  entryBuffer: 80,
  minGapSeconds: 1.05,
  maxGapSeconds: 1.55,
  cactusGroupChance: 0.48,
  pterodactylChance: 0.22,
  pterodactylFrameDuration: 0.12,
  cacti: Object.freeze([
    Object.freeze({ variant: "small", width: 18, height: 34 }),
    Object.freeze({ variant: "tall", width: 22, height: 48 }),
    Object.freeze({ variant: "wide", width: 30, height: 36 }),
  ]),
  pterodactyl: Object.freeze({ width: 46, height: 26 }),
  pterodactylBottomOffsets: Object.freeze([34, 70, 104]),
});

const HITBOX_INSETS = Object.freeze({
  cactus: Object.freeze({ left: 3, right: 3, top: 2, bottom: 1 }),
  pterodactyl: Object.freeze({ left: 4, right: 4, top: 3, bottom: 3 }),
});

/**
 * Owns active obstacle records. Distances and movement use world pixels;
 * `deltaTime` is in seconds and `speed` is supplied by the game in px/second.
 */
export class Obstacles {
  constructor(options = {}) {
    const { random = Math.random, ...configOptions } = options;
    this.config = { ...DEFAULT_CONFIG, ...configOptions };
    this.random = random;
    this._validateConfig();
    this.reset();
  }

  /** Move existing obstacles and spawn the next pattern when its gap is due. */
  update(deltaTime, speed, options = {}) {
    const { allowSpawn = true } = options;
    if (!Number.isFinite(deltaTime) || deltaTime < 0) {
      throw new RangeError("deltaTime must be a finite number greater than or equal to zero.");
    }
    if (!Number.isFinite(speed) || speed < 0) {
      throw new RangeError("speed must be a finite number greater than or equal to zero.");
    }
    if (deltaTime === 0) return;

    if (speed === 0) {
      for (const obstacle of this.obstacles) {
        if (obstacle.type === ObstacleType.PTERODACTYL) obstacle.animationTime += deltaTime;
      }
      return;
    }

    const distance = speed * deltaTime;
    if (allowSpawn && this.distanceUntilSpawn === null) {
      this.distanceUntilSpawn = this.initialPatternWidth + this.nextGapSeconds * speed;
    }
    if (allowSpawn) this.distanceUntilSpawn -= distance;

    for (const obstacle of this.obstacles) {
      obstacle.x -= distance;
      obstacle.velocityX = -speed;
      if (obstacle.type === ObstacleType.PTERODACTYL) {
        obstacle.animationTime += deltaTime;
      }
    }

    this.obstacles = this.obstacles.filter(
      (obstacle) => obstacle.x + obstacle.width > 0,
    );

    if (!allowSpawn) return;

    // A bounded catch-up loop handles normal frame variation without letting a
    // very large background-tab delta create an unbounded spawn burst.
    let spawnCount = 0;
    while (this.distanceUntilSpawn <= 0 && spawnCount < 8) {
      const overshoot = -this.distanceUntilSpawn;
      const pattern = this._spawnPattern(this.config.screenWidth + this.config.entryBuffer - overshoot);
      this.nextGapSeconds = this._randomBetween(this.config.minGapSeconds, this.config.maxGapSeconds);
      this.distanceUntilSpawn += pattern.width + this.nextGapSeconds * speed;
      spawnCount += 1;
    }

    // Discard catch-up patterns that are already beyond the viewport.
    this.obstacles = this.obstacles.filter(
      (obstacle) => obstacle.x + obstacle.width > 0,
    );
    if (this.distanceUntilSpawn <= 0) {
      this.distanceUntilSpawn = this.initialPatternWidth + this.nextGapSeconds * speed;
    }
  }

  /** Restore an initial off-screen pattern and reset local IDs/animation state. */
  reset() {
    this.obstacles = [];
    this.nextId = 1;
    this.nextPatternId = 1;
    this.lastType = null;
    const firstPattern = this._spawnPattern(this.config.screenWidth + this.config.entryBuffer);
    this.initialPatternWidth = firstPattern.width;
    this.nextGapSeconds = this._randomBetween(this.config.minGapSeconds, this.config.maxGapSeconds);
    this.distanceUntilSpawn = null;
  }

  /** Remove current obstacles before a scripted final approach begins. */
  clear() {
    this.obstacles = [];
    this.distanceUntilSpawn = null;
    this.lastType = null;
  }

  /** Create a controlled final obstacle that is not part of the normal spawn cadence. */
  spawnFinalObstacle({ x = this.config.screenWidth + 120, groundY = this.config.groundY } = {}) {
    const finalObstacle = this._createObstacle({
      id: this.nextId++,
      patternId: this.nextPatternId++,
      type: ObstacleType.CACTUS,
      variant: "wide",
      x,
      y: groundY - 36,
      width: 30,
      height: 36,
      velocityX: 0,
      animationTime: 0,
      finalObstacle: true,
    });
    this.obstacles.push(finalObstacle);
    return finalObstacle.id;
  }

  /** Return detached renderer-facing obstacle records. */
  getObstacles() {
    return this.obstacles.map((obstacle) => this._toSnapshot(obstacle));
  }

  /** Return collision boxes with the corresponding obstacle IDs/types. */
  getHitboxes() {
    return this.obstacles.map((obstacle) => ({
      id: obstacle.id,
      type: obstacle.type,
      patternId: obstacle.patternId,
      ...this._getHitbox(obstacle),
    }));
  }

  /** Full detached state for game/debug consumers. */
  getSnapshot() {
    return {
      obstacles: this.getObstacles(),
      hitboxes: this.getHitboxes(),
      distanceUntilSpawn: this.distanceUntilSpawn,
    };
  }

  _spawnPattern(startX) {
    const patternId = this.nextPatternId++;
    const canSpawnBird = this.lastType !== ObstacleType.PTERODACTYL;
    const spawnBird = canSpawnBird && this._random() < this.config.pterodactylChance;

    if (spawnBird) {
      const heightIndex = Math.floor(this._random() * this.config.pterodactylBottomOffsets.length);
      const bottomOffset = this.config.pterodactylBottomOffsets[heightIndex];
      const { width, height } = this.config.pterodactyl;
      const obstacle = this._createObstacle({
        id: this.nextId++,
        patternId,
        type: ObstacleType.PTERODACTYL,
        variant: "flapping",
        x: startX,
        y: this.config.groundY - bottomOffset - height,
        width,
        height,
        velocityX: 0,
        animationTime: 0,
        flightHeight: bottomOffset,
      });
      this.obstacles.push(obstacle);
      this.lastType = ObstacleType.PTERODACTYL;
      return { width };
    }

    const groupSize = this._random() < this.config.cactusGroupChance
      ? 2 + Math.floor(this._random() * 2)
      : 1;
    let offsetX = 0;

    for (let index = 0; index < groupSize; index += 1) {
      const variantIndex = Math.floor(this._random() * this.config.cacti.length);
      const variant = this.config.cacti[variantIndex];
      const obstacle = this._createObstacle({
        id: this.nextId++,
        patternId,
        type: ObstacleType.CACTUS,
        variant: variant.variant,
        x: startX + offsetX,
        y: this.config.groundY - variant.height,
        width: variant.width,
        height: variant.height,
        velocityX: 0,
        animationTime: 0,
      });
      this.obstacles.push(obstacle);
      offsetX += variant.width + (index < groupSize - 1 ? this._randomBetween(12, 18) : 0);
    }

    this.lastType = ObstacleType.CACTUS;
    return { width: offsetX };
  }

  _createObstacle(data) {
    return data;
  }

  _toSnapshot(obstacle) {
    const bounds = { x: obstacle.x, y: obstacle.y, width: obstacle.width, height: obstacle.height };
    return {
      id: obstacle.id,
      patternId: obstacle.patternId,
      type: obstacle.type,
      variant: obstacle.variant,
      x: obstacle.x,
      y: obstacle.y,
      width: obstacle.width,
      height: obstacle.height,
      velocityX: obstacle.velocityX,
      flightHeight: obstacle.flightHeight ?? null,
      finalObstacle: Boolean(obstacle.finalObstacle),
      bounds,
      hitbox: this._getHitbox(obstacle),
      animation: this._getAnimation(obstacle),
    };
  }

  _getHitbox(obstacle) {
    const inset = HITBOX_INSETS[obstacle.type];
    return {
      x: obstacle.x + inset.left,
      y: obstacle.y + inset.top,
      width: Math.max(0, obstacle.width - inset.left - inset.right),
      height: Math.max(0, obstacle.height - inset.top - inset.bottom),
    };
  }

  _getAnimation(obstacle) {
    if (obstacle.type !== ObstacleType.PTERODACTYL) {
      return { name: "static", frame: 0, frameCount: 1, duration: null };
    }
    const frameCount = 2;
    const frame = Math.floor(obstacle.animationTime / this.config.pterodactylFrameDuration) % frameCount;
    return {
      name: "flap",
      frame,
      frameCount,
      duration: this.config.pterodactylFrameDuration,
    };
  }

  _randomBetween(min, max) {
    return min + this._random() * (max - min);
  }

  _random() {
    const value = this.random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError("The random function must return a number in [0, 1).");
    }
    return value;
  }

  _validateConfig() {
    if (typeof this.random !== "function") {
      throw new TypeError("random must be a function returning values in [0, 1).");
    }
    const positiveKeys = ["screenWidth", "entryBuffer", "minGapSeconds", "maxGapSeconds", "pterodactylFrameDuration"];
    for (const key of positiveKeys) {
      if (!Number.isFinite(this.config[key]) || this.config[key] <= 0) {
        throw new RangeError(`${key} must be a positive finite number.`);
      }
    }
    if (!Number.isFinite(this.config.groundY)) {
      throw new TypeError("groundY must be a finite number.");
    }
    if (this.config.maxGapSeconds < this.config.minGapSeconds) {
      throw new RangeError("maxGapSeconds must be greater than or equal to minGapSeconds.");
    }
    for (const key of ["cactusGroupChance", "pterodactylChance"]) {
      if (!Number.isFinite(this.config[key]) || this.config[key] < 0 || this.config[key] > 1) {
        throw new RangeError(`${key} must be between zero and one.`);
      }
    }
    if (!Array.isArray(this.config.cacti) || this.config.cacti.length === 0) {
      throw new TypeError("cacti must contain at least one cactus variant.");
    }
    if (!Array.isArray(this.config.pterodactylBottomOffsets) || this.config.pterodactylBottomOffsets.length === 0) {
      throw new TypeError("pterodactylBottomOffsets must contain at least one height.");
    }
    for (const cactus of this.config.cacti) {
      if (!cactus.variant || !Number.isFinite(cactus.width) || cactus.width <= 0 || !Number.isFinite(cactus.height) || cactus.height <= 0) {
        throw new TypeError("Each cactus variant requires a name and positive finite width/height.");
      }
    }
    for (const offset of this.config.pterodactylBottomOffsets) {
      if (!Number.isFinite(offset) || offset <= 0) {
        throw new TypeError("Pterodactyl height offsets must be positive finite numbers.");
      }
    }
    if (!this.config.pterodactyl || !Number.isFinite(this.config.pterodactyl.width) || this.config.pterodactyl.width <= 0 || !Number.isFinite(this.config.pterodactyl.height) || this.config.pterodactyl.height <= 0) {
      throw new TypeError("Pterodactyl dimensions must be positive finite numbers.");
    }
  }
}

export default Obstacles;
