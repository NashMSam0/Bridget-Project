import Phaser from "phaser";
import type {
  CatcherLevel,
  GameMode,
  GamePalette,
  GridMissionLevel,
  MissionLevel,
  PatternLevel,
  PlatformerLevel,
  RacingLevel,
} from "./catalogue";
import type { CompiledProgram, Stmt } from "./blocks";
import { runEvent, runProgram, type GameHost } from "./interpreter";

export type RuntimeStatus = "idle" | "running" | "won" | "lost";

export interface RuntimeState {
  status: RuntimeStatus;
  hearts: number;
  collected: number;
  required: number;
  score: number;
  timeLeft: number | null;
  message: string;
  progress: number;
}

export interface RunOutcome {
  status: "won" | "lost";
  score: number;
  stars: number;
  timeTaken: number;
  message: string;
  blocksUsed: number;
  budget?: number;
}

export interface GameOptions {
  mode: GameMode;
  level: MissionLevel;
  character: "boy" | "girl";
  palette: GamePalette;
  sound: boolean;
  blockBudget?: number;
  onState: (state: RuntimeState) => void;
  onEnd: (outcome: RunOutcome) => void;
}

export interface GameController {
  run: (program: CompiledProgram) => Promise<void>;
  runEventStatements: (statements: Stmt[], functions: Record<string, Stmt[]>) => Promise<void>;
  stop: () => void;
  reset: () => void;
  resetAsync: () => Promise<void>;
  destroy: () => void;
  setSound: (on: boolean) => void;
  setCharacter: (character: "boy" | "girl") => void;
  clickHero: () => void;
  getState: () => RuntimeState;
}

const TILE = 60;
const COLS = 15;
const ROWS = 9;
const WIDTH = COLS * TILE;
const HEIGHT = ROWS * TILE;

type GridItem = {
  kind: "treasure" | "crystal" | "key";
  sprite: Phaser.GameObjects.Image;
  collected: boolean;
};

export async function createGame(
  container: HTMLElement,
  options: GameOptions,
): Promise<GameController> {
  const scene = new CodeBloomScene(options);
  const controller = new CodeBloomController(scene, options);

  await new Promise<void>((resolve) => {
    scene.onReady = resolve;
    new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      width: WIDTH,
      height: HEIGHT,
      backgroundColor: options.palette.sky,
      transparent: false,
      audio: { noAudio: true },
      physics: {
        default: "arcade",
        arcade: { gravity: { x: 0, y: 0 }, debug: false },
      },
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: WIDTH,
        height: HEIGHT,
      },
      scene,
    });
  });

  controller.attachGame(scene.game);
  return controller;
}

class CodeBloomController implements GameController {
  private scene: CodeBloomScene;
  private game: Phaser.Game | null = null;

  constructor(scene: CodeBloomScene, options: GameOptions) {
    this.scene = scene;
    this.options = options;
  }

  private options: GameOptions;

  attachGame(game: Phaser.Game): void {
    this.game = game;
  }

  run(program: CompiledProgram): Promise<void> {
    return this.runInternal(program);
  }

  private async runInternal(program: CompiledProgram): Promise<void> {
    if (this.scene.isFinished()) {
      await this.scene.restartScene();
    }
    await this.scene.startProgram(program);
  }

  runEventStatements(statements: Stmt[], functions: Record<string, Stmt[]>): Promise<void> {
    return this.scene.startEvent(statements, functions);
  }

  stop(): void {
    this.scene.cancelRun();
  }

  reset(): void {
    this.scene.cancelRun();
    this.scene.scene.restart();
  }

  async resetAsync(): Promise<void> {
    this.scene.cancelRun();
    await this.scene.restartScene();
  }

  destroy(): void {
    this.scene.cancelRun();
    this.game?.destroy(true);
    this.game = null;
  }

  setSound(on: boolean): void {
    this.scene.soundEnabled = on;
  }

  setCharacter(character: "boy" | "girl"): void {
    this.options.character = character;
    this.scene.applyCharacter(character);
  }

  clickHero(): void {
    this.scene.triggerHeroClick();
  }

  getState(): RuntimeState {
    return this.scene.snapshot();
  }
}

class CodeBloomScene extends Phaser.Scene implements GameHost {
  onReady: (() => void) | null = null;

  private options: GameOptions;

  // Run bookkeeping -----------------------------------------------------
  soundEnabled: boolean;
  private cancelledFlag = false;
  private running = false;
  private pending: Array<() => void> = [];
  private eventFunctions: Record<string, Stmt[]> = {};
  private clickStatements: Stmt[] = [];
  private keyStatements: Stmt[] = [];
  private blocksUsed = 0;
  private blockBudget: number | undefined;

  // Shared state --------------------------------------------------------
  private status: RuntimeStatus = "idle";
  private hearts = 3;
  private collected = 0;
  private required = 1;
  private score = 0;
  private message = "";
  private startedAt = 0;
  private timeLimit: number | null = null;
  private timeLeft: number | null = null;
  private lastEmit = 0;
  private vars: Record<string, number> = {};
  private facing: 0 | 1 | 2 | 3 = 0;
  private speed = 5;
  private hero: Phaser.Physics.Arcade.Sprite | null = null;
  private character: "boy" | "girl";
  private atGoal = false;
  private hazardUntil = 0;
  private keyState: Record<string, boolean> = {};
  private keyHandler: ((event: KeyboardEvent) => void) | null = null;
  private keyUpHandler: ((event: KeyboardEvent) => void) | null = null;

  // Grid ---------------------------------------------------------------
  private gridWalls = new Set<string>();
  private gridHazards = new Set<string>();
  private gridItems = new Map<string, GridItem>();
  private gridGoal = { x: 14, y: 0 };
  private gridStart = { x: 0, y: 8 };
  private heroTile = { x: 0, y: 8 };
  private moving = false;
  private spaceGlow: Phaser.GameObjects.Arc | null = null;

  // Pattern ------------------------------------------------------------
  private patternPads: Array<{ x: number; y: number; colour: number; sprite: Phaser.GameObjects.Arc }> = [];
  private patternSequence: number[] = [];
  private patternIndex = 0;
  private patternMistakes = 0;
  private patternShowing = false;

  // Platformer ---------------------------------------------------------
  private starsGroup: Phaser.Physics.Arcade.StaticGroup | null = null;
  private platformRects: Phaser.GameObjects.Rectangle[] = [];
  private flagSprite: Phaser.GameObjects.Image | null = null;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | null = null;
  private wasd: Record<string, Phaser.Input.Keyboard.Key> | null = null;
  private respawn = { x: 80, y: 450 };

  // Racing -------------------------------------------------------------
  private car: Phaser.Physics.Arcade.Sprite | null = null;
  private raceCheckpoints: Array<{ x: number; y: number }> = [];
  private raceNext = 0;
  private checkpointRing: Phaser.GameObjects.Arc | null = null;

  // Catcher ------------------------------------------------------------
  private basket: Phaser.Physics.Arcade.Sprite | null = null;
  private fallingStars: Phaser.Physics.Arcade.Group | null = null;
  private fallingBombs: Phaser.Physics.Arcade.Group | null = null;
  private spawnEvent: Phaser.Time.TimerEvent | null = null;
  private spawnCount = 0;

  constructor(options: GameOptions) {
    super("codebloom-game");
    this.options = options;
    this.soundEnabled = options.sound;
    this.character = options.character;
  }

  preload(): void {
    this.load.image("hero-girl", "/girl_transparent.png");
    this.load.image("hero-boy", "/boy_transparent.png");
  }

  create(): void {
    this.resetFields();
    this.createTextures();
    this.drawBackground();

    const level = this.options.level;
    switch (level.kind) {
      case "grid":
        this.buildGrid(level);
        break;
      case "pattern":
        this.buildPattern(level);
        break;
      case "platformer":
        this.buildPlatformer(level);
        break;
      case "racing":
        this.buildRacing(level);
        break;
      case "catcher":
        this.buildCatcher(level);
        break;
    }

    this.setupKeyboard();
    this.emitState(true);
    this.time.delayedCall(30, () => {
      this.onReady?.();
      this.onReady = null;
    });
  }

  private resetFields(): void {
    this.cancelledFlag = false;
    this.running = false;
    this.pending = [];
    this.status = "idle";
    this.hearts = 3;
    this.collected = 0;
    this.required = 1;
    this.score = 0;
    this.message = "";
    this.startedAt = 0;
    this.timeLimit = null;
    this.timeLeft = null;
    this.lastEmit = 0;
    this.vars = { score: 0, lives: 3, speed: 5, time: 0, collected: 0 };
    this.speed = 5;
    this.facing = 0;
    this.atGoal = false;
    this.hazardUntil = 0;
    this.moving = false;
    this.spaceGlow = null;
    this.gridWalls.clear();
    this.gridHazards.clear();
    this.gridItems.clear();
    this.patternPads = [];
    this.patternSequence = [];
    this.patternIndex = 0;
    this.patternMistakes = 0;
    this.patternShowing = false;
    this.starsGroup = null;
    this.platformRects = [];
    this.flagSprite = null;
    this.cursors = null;
    this.wasd = null;
    this.car = null;
    this.raceCheckpoints = [];
    this.raceNext = 0;
    this.checkpointRing = null;
    this.basket = null;
    this.fallingStars = null;
    this.fallingBombs = null;
    this.spawnEvent = null;
    this.spawnCount = 0;
    this.clickStatements = [];
    this.keyStatements = [];
    this.eventFunctions = {};
    this.blocksUsed = 0;
    this.blockBudget = this.options.blockBudget;
    this.hero = null;
    this.keyState = {};
    this.keyHandler = null;
    this.keyUpHandler = null;
  }

  // ------------------------------------------------------------------
  // Public controls
  // ------------------------------------------------------------------

  setProgram(program: CompiledProgram): void {
    this.clickStatements = program.onClick;
    this.keyStatements = program.onKey;
    this.eventFunctions = program.functions;
    this.blocksUsed = program.blockCount;
  }

  async startProgram(program: CompiledProgram): Promise<void> {
    if (this.running) return;
    this.cancelledFlag = false;
    this.running = true;
    this.setProgram(program);
    this.beginPlay();
    await runProgram(program, this);
    this.running = false;
    if (
      !this.cancelledFlag &&
      !this.isFinished() &&
      this.message === "Running your blocks…"
    ) {
      this.setMessage("Program finished. Reach the goal to complete the mission!");
    }
  }

  isFinished(): boolean {
    return this.status === "won" || this.status === "lost";
  }

  restartScene(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.onReady = resolve;
      this.scene.restart();
    });
  }

  async startEvent(statements: Stmt[], functions: Record<string, Stmt[]>): Promise<void> {
    if (this.running || this.status === "won" || this.status === "lost") return;
    this.cancelledFlag = false;
    this.running = true;
    this.beginPlay();
    await runEvent(statements, functions, this);
    this.running = false;
  }

  cancelRun(): void {
    this.cancelledFlag = true;
    this.running = false;
    const pending = this.pending;
    this.pending = [];
    for (const resolve of pending) resolve();
    this.tweens.killAll();
  }

  triggerHeroClick(): void {
    if (this.status === "won" || this.status === "lost") return;
    if (this.clickStatements.length > 0 && !this.running) {
      void this.startEvent(this.clickStatements, this.eventFunctions);
    }
  }

  applyCharacter(character: "boy" | "girl"): void {
    this.character = character;
    if (this.hero) {
      this.hero.setTexture(character === "girl" ? "hero-girl" : "hero-boy");
      this.hero.setDisplaySize(46, 58);
    }
  }

  snapshot(): RuntimeState {
    return {
      status: this.status,
      hearts: this.hearts,
      collected: this.collected,
      required: this.required,
      score: this.score,
      timeLeft: this.timeLeft,
      message: this.message,
      progress: this.patternSequence.length > 0 ? this.patternIndex : this.collected,
    };
  }

  // ------------------------------------------------------------------
  // Setup helpers
  // ------------------------------------------------------------------

  private createTextures(): void {
    const make = (key: string, width: number, height: number, draw: (g: Phaser.GameObjects.Graphics) => void) => {
      if (this.textures.exists(key)) return;
      const g = this.add.graphics();
      draw(g);
      g.generateTexture(key, width, height);
      g.destroy();
    };

    make("cb-star", 40, 40, (g) => {
      const points: Phaser.Geom.Point[] = [];
      for (let i = 0; i < 10; i += 1) {
        const radius = i % 2 === 0 ? 18 : 8;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        points.push(new Phaser.Geom.Point(20 + Math.cos(angle) * radius, 20 + Math.sin(angle) * radius));
      }
      g.fillStyle(0x94a3b8, 1);
      g.fillPoints(points, true);
      g.fillStyle(0xffc300, 1);
      g.fillPoints(points.map((p) => new Phaser.Geom.Point(p.x - 1, p.y - 1)), true);
    });

    make("cb-chest", 48, 44, (g) => {
      g.fillStyle(0x7c2d12, 1);
      g.fillRoundedRect(3, 16, 42, 24, 5);
      g.fillStyle(0xb45309, 1);
      g.fillRoundedRect(3, 10, 42, 14, 6);
      g.fillStyle(0xffc300, 1);
      g.fillRect(20, 10, 8, 30);
      g.fillStyle(0x062d58, 1);
      g.fillCircle(24, 26, 4);
    });

    make("cb-crystal", 40, 44, (g) => {
      g.fillStyle(0x0e7490, 1);
      g.fillPoints(
        [
          new Phaser.Geom.Point(20, 2),
          new Phaser.Geom.Point(36, 20),
          new Phaser.Geom.Point(20, 42),
          new Phaser.Geom.Point(4, 20),
        ],
        true,
      );
      g.fillStyle(0x67e8f9, 1);
      g.fillPoints(
        [
          new Phaser.Geom.Point(20, 6),
          new Phaser.Geom.Point(31, 20),
          new Phaser.Geom.Point(20, 30),
          new Phaser.Geom.Point(12, 20),
        ],
        true,
      );
    });

    make("cb-key", 44, 30, (g) => {
      g.lineStyle(7, 0xffc300, 1);
      g.strokeCircle(13, 15, 9);
      g.fillStyle(0xffc300, 1);
      g.fillRect(20, 12, 20, 6);
      g.fillRect(34, 17, 6, 7);
    });

    make("cb-thorn", 54, 40, (g) => {
      g.fillStyle(0x14532d, 1);
      g.fillTriangle(2, 38, 16, 8, 28, 38);
      g.fillStyle(0x166534, 1);
      g.fillTriangle(18, 38, 33, 4, 46, 38);
      g.fillStyle(0x22c55e, 1);
      g.fillTriangle(30, 38, 40, 18, 52, 38);
    });

    make("cb-asteroid", 52, 52, (g) => {
      g.fillStyle(0x64748b, 1);
      g.fillCircle(26, 26, 23);
      g.fillStyle(0x475569, 1);
      g.fillCircle(18, 20, 6);
      g.fillCircle(34, 31, 5);
      g.fillCircle(27, 12, 3);
      g.fillStyle(0x94a3b8, 1);
      g.fillCircle(22, 33, 4);
    });

    make("cb-temple", 62, 62, (g) => {
      g.fillStyle(0xb45309, 1);
      g.fillRect(8, 30, 46, 28);
      g.fillStyle(0xffc300, 1);
      g.fillTriangle(3, 32, 31, 4, 59, 32);
      g.fillStyle(0x062d58, 1);
      g.fillRoundedRect(23, 42, 16, 16, 3);
      g.fillStyle(0xfef3c7, 1);
      g.fillRect(10, 34, 8, 4);
      g.fillRect(44, 34, 8, 4);
    });

    make("cb-warp", 62, 62, (g) => {
      g.fillStyle(0x0e7490, 0.45);
      g.fillCircle(31, 31, 28);
      g.lineStyle(6, 0x22d3ee, 1);
      g.strokeCircle(31, 31, 22);
      g.lineStyle(3, 0xa5f3fc, 1);
      g.strokeCircle(31, 31, 13);
      g.fillStyle(0xffffff, 1);
      g.fillCircle(31, 31, 4);
    });

    make("cb-exit", 56, 58, (g) => {
      g.fillStyle(0x0f766e, 1);
      g.fillRoundedRect(6, 4, 44, 52, 6);
      g.fillStyle(0x062d58, 1);
      g.fillRoundedRect(12, 10, 32, 46, 4);
      g.fillStyle(0xffc300, 1);
      g.fillCircle(38, 34, 3);
      g.fillStyle(0xbbf7d0, 0.5);
      g.fillRect(15, 13, 26, 5);
    });

    make("cb-flag", 60, 70, (g) => {
      g.fillStyle(0x475569, 1);
      g.fillRect(10, 4, 5, 62);
      g.fillStyle(0xffc300, 1);
      g.fillTriangle(15, 8, 52, 20, 15, 34);
      g.fillStyle(0xea580c, 1);
      g.fillCircle(12, 64, 6);
    });

    make("cb-cone", 40, 40, (g) => {
      g.fillStyle(0xea580c, 1);
      g.fillTriangle(20, 3, 37, 36, 3, 36);
      g.fillStyle(0xffffff, 1);
      g.fillRect(11, 19, 18, 6);
      g.fillStyle(0x7c2d12, 1);
      g.fillRoundedRect(5, 34, 30, 5, 2);
    });

    make("cb-bomb", 42, 46, (g) => {
      g.fillStyle(0x1f2937, 1);
      g.fillCircle(21, 26, 16);
      g.fillStyle(0x4b5563, 1);
      g.fillCircle(15, 20, 4);
      g.lineStyle(3, 0xf59e0b, 1);
      g.lineBetween(24, 10, 32, 2);
      g.fillStyle(0xef4444, 1);
      g.fillCircle(34, 2, 4);
    });

    make("cb-basket", 90, 44, (g) => {
      g.fillStyle(0x92400e, 1);
      g.fillPoints(
        [
          new Phaser.Geom.Point(6, 8),
          new Phaser.Geom.Point(84, 8),
          new Phaser.Geom.Point(70, 40),
          new Phaser.Geom.Point(20, 40),
        ],
        true,
      );
      g.fillStyle(0xffc300, 1);
      g.fillRoundedRect(4, 4, 82, 10, 5);
      g.lineStyle(2, 0xfcd34d, 0.8);
      g.lineBetween(28, 15, 34, 38);
      g.lineBetween(45, 15, 45, 38);
      g.lineBetween(62, 15, 56, 38);
    });

    make("cb-car", 52, 34, (g) => {
      g.fillStyle(0x111827, 1);
      g.fillRoundedRect(3, 8, 46, 20, 7);
      g.fillStyle(0xef4444, 1);
      g.fillRoundedRect(6, 4, 40, 18, 7);
      g.fillStyle(0xfacc15, 1);
      g.fillRect(18, 4, 16, 18);
      g.fillStyle(0x1f2937, 1);
      g.fillRoundedRect(8, 2, 9, 6, 2);
      g.fillRoundedRect(35, 2, 9, 6, 2);
      g.fillRoundedRect(8, 24, 9, 6, 2);
      g.fillRoundedRect(35, 24, 9, 6, 2);
      g.fillStyle(0xbae6fd, 1);
      g.fillRect(24, 7, 5, 12);
    });

    make("cb-wall", TILE, TILE, (g) => {
      g.fillStyle(0x1e293b, 1);
      g.fillRoundedRect(1, 1, TILE - 2, TILE - 2, 6);
      g.lineStyle(2, 0x475569, 1);
      g.strokeRoundedRect(4, 4, TILE - 8, TILE - 8, 5);
    });

    make("cb-pad", 52, 52, (g) => {
      g.fillStyle(0xffffff, 1);
      g.fillCircle(26, 26, 24);
      g.fillStyle(0xf8fafc, 1);
      g.fillCircle(26, 26, 17);
    });

    make("cb-cloud", 120, 50, (g) => {
      g.fillStyle(0xffffff, 0.9);
      g.fillCircle(30, 32, 20);
      g.fillCircle(58, 22, 25);
      g.fillCircle(88, 32, 20);
      g.fillRoundedRect(24, 28, 70, 20, 10);
    });
  }

  private drawBackground(): void {
    const palette = this.options.palette;
    const bg = this.add.graphics().setDepth(-10);
    bg.fillStyle(Phaser.Display.Color.HexStringToColor(palette.sky).color, 1);
    bg.fillRect(0, 0, WIDTH, HEIGHT);
    bg.fillStyle(Phaser.Display.Color.HexStringToColor(palette.sky2).color, 0.55);
    bg.fillRect(0, HEIGHT * 0.45, WIDTH, HEIGHT * 0.55);

    if (this.options.mode === "space" || this.options.mode === "catcher") {
      for (let i = 0; i < 70; i += 1) {
        const x = Phaser.Math.Between(0, WIDTH);
        const y = Phaser.Math.Between(0, HEIGHT);
        bg.fillStyle(0xffffff, Phaser.Math.FloatBetween(0.15, 0.8));
        bg.fillCircle(x, y, Phaser.Math.FloatBetween(0.6, 2));
      }
    }

    if (this.options.mode === "jungle") {
      bg.fillStyle(0x14532d, 0.65);
      for (let i = 0; i < 8; i += 1) {
        const x = i * 130 + 20;
        bg.fillCircle(x, 30, 60);
        bg.fillCircle(x + 50, 18, 48);
      }
    }

    if (this.options.mode === "platformer") {
      for (let i = 0; i < 5; i += 1) {
        this.add.image(120 + i * 200, 80 + (i % 2) * 50, "cb-cloud").setAlpha(0.75);
      }
    }

    if (this.options.mode === "pattern") {
      bg.fillStyle(0xffffff, 0.35);
      for (let i = 0; i < 30; i += 1) {
        bg.fillCircle(Phaser.Math.Between(0, WIDTH), Phaser.Math.Between(0, HEIGHT), Phaser.Math.Between(2, 5));
      }
    }

    if (this.options.mode === "racing") {
      this.drawRacingTrack(bg);
    }
  }

  private drawRacingTrack(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0x0f172a, 1);
    g.fillRect(0, 0, WIDTH, HEIGHT);
    g.fillStyle(0x334155, 1);
    g.fillRect(30, 30, WIDTH - 60, HEIGHT - 60);
    g.fillStyle(0x111827, 1);
    g.fillRect(300, 150, 360, 240);
    g.lineStyle(4, 0xfacc15, 0.9);
    g.strokeRect(30, 30, WIDTH - 60, HEIGHT - 60);
    g.strokeRect(300, 150, 360, 240);
    g.setDepth(-9);
  }

  // ------------------------------------------------------------------
  // Grid games (jungle, maze, space, pattern)
  // ------------------------------------------------------------------

  private buildGrid(level: GridMissionLevel): void {
    this.gridGoal = { x: 14, y: 0 };
    this.gridStart = { x: 0, y: 8 };
    this.facing = level.startDir;
    this.timeLimit = null;

    const floor = this.add.graphics().setDepth(-5);
    floor.fillStyle(0x000000, 0.14);
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        if ((row + col) % 2 === 0) {
          floor.fillRect(col * TILE, row * TILE, TILE, TILE);
        }
      }
    }

    for (let row = 0; row < level.rows.length; row += 1) {
      const line = level.rows[row];
      for (let col = 0; col < line.length; col += 1) {
        const char = line[col];
        const cx = col * TILE + TILE / 2;
        const cy = row * TILE + TILE / 2;
        switch (char) {
          case "#":
            this.gridWalls.add(`${col},${row}`);
            this.add.image(cx, cy, "cb-wall").setDisplaySize(TILE, TILE).setDepth(1);
            break;
          case "~":
            this.gridHazards.add(`${col},${row}`);
            this.add
              .image(cx, cy, this.options.mode === "space" ? "cb-asteroid" : "cb-thorn")
              .setDisplaySize(50, 40)
              .setDepth(2);
            break;
          case "T":
            this.addGridItem("treasure", col, row, "cb-chest");
            break;
          case "C":
            this.addGridItem("crystal", col, row, "cb-crystal");
            break;
          case "K":
            this.addGridItem("key", col, row, "cb-key");
            break;
          case "G":
            this.gridGoal = { x: col, y: row };
            this.add
              .image(cx, cy, this.goalTexture())
              .setDisplaySize(58, 58)
              .setDepth(1);
            break;
          case "S":
            this.gridStart = { x: col, y: row };
            break;
          default:
            break;
        }
      }
    }

    this.required = this.gridItems.size;
    if (this.options.mode === "jungle") {
      this.required = Math.min(this.required, this.gridItems.size);
    }
    this.collected = 0;
    this.heroTile = { ...this.gridStart };
    this.hero = this.physics.add.sprite(
      this.gridStart.x * TILE + TILE / 2,
      this.gridStart.y * TILE + TILE / 2,
      this.character === "girl" ? "hero-girl" : "hero-boy",
    );
    this.hero.setDisplaySize(46, 58).setDepth(5);
    this.hero.setInteractive({ useHandCursor: true });
    this.hero.on("pointerdown", () => this.triggerHeroClick());

    if (this.options.mode === "space") {
      this.spaceGlow = this.add.circle(this.hero.x, this.hero.y, 30, 0x22d3ee, 0.18).setDepth(4);
    }

    this.message =
      this.options.mode === "maze"
        ? "Collect every key, then reach the exit."
        : this.options.mode === "space"
          ? "Collect the crystals and fly to the warp gate."
          : "Collect the treasure and reach the temple.";
  }

  private addGridItem(kind: GridItem["kind"], col: number, row: number, texture: string): void {
    const sprite = this.add
      .image(col * TILE + TILE / 2, row * TILE + TILE / 2, texture)
      .setDisplaySize(44, 40)
      .setDepth(3);
    this.tweens.add({
      targets: sprite,
      y: sprite.y - 5,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.gridItems.set(`${col},${row}`, { kind, sprite, collected: false });
  }

  private goalTexture(): string {
    switch (this.options.mode) {
      case "maze":
        return "cb-exit";
      case "space":
        return "cb-warp";
      default:
        return "cb-temple";
    }
  }

  private async step(dx: number, dy: number): Promise<void> {
    if (!this.hero || this.moving || this.status === "won" || this.status === "lost") return;
    this.ensureStarted();
    const targetX = this.heroTile.x + dx;
    const targetY = this.heroTile.y + dy;
    if (targetX < 0 || targetX >= COLS || targetY < 0 || targetY >= ROWS) {
      this.setMessage("That is the edge of the map.");
      return;
    }
    if (this.gridWalls.has(`${targetX},${targetY}`)) {
      this.setMessage("A wall blocks the way. Try another direction.");
      return;
    }

    this.facing = dx === 1 ? 0 : dx === -1 ? 2 : dy === 1 ? 1 : 3;
    this.moving = true;
    const duration = Math.max(110, 260 - this.speed * 18);
    await this.awaitTween(this.hero, targetX * TILE + TILE / 2, targetY * TILE + TILE / 2, duration);
    this.heroTile = { x: targetX, y: targetY };
    this.moving = false;
    this.enterTile(targetX, targetY);
  }

  private enterTile(x: number, y: number): void {
    if (this.options.level.kind === "pattern") {
      this.checkPatternPad(x, y);
      this.emitState(true);
      return;
    }
    const key = `${x},${y}`;
    const item = this.gridItems.get(key);
    if (item && !item.collected) {
      item.collected = true;
      item.sprite.destroy();
      this.gridItems.delete(key);
      this.collected += 1;
      this.score += 100;
      this.message =
        item.kind === "key"
          ? `Key collected! ${this.remaining()} to find.`
          : `${this.labelForKind(item.kind)} collected! ${this.remaining()} to go.`;
      this.playTone(880, 0.12, "triangle");
      this.time.delayedCall(80, () => this.playTone(1320, 0.1, "triangle"));
      this.emitState(true);
    }

    if (this.gridHazards.has(key) && this.time.now > this.hazardUntil) {
      this.hazardUntil = this.time.now + 900;
      this.damage(1, "Ouch! That hazard cost a heart.");
    }

    this.atGoal = x === this.gridGoal.x && y === this.gridGoal.y;
    if (this.atGoal) this.checkGridWin();
    this.emitState(true);
  }

  private remaining(): number {
    return Math.max(0, this.required - this.collected);
  }

  private labelForKind(kind: GridItem["kind"]): string {
    return kind === "crystal" ? "Crystal" : kind === "key" ? "Key" : "Treasure";
  }

  private checkGridWin(): void {
    if (!this.atGoal || this.status === "won" || this.status === "lost") return;
    if (this.collected < this.required) {
      this.setMessage(`Collect ${this.required - this.collected} more before entering the goal.`);
      return;
    }
    this.finishWin();
  }

  // ------------------------------------------------------------------
  // Pattern game
  // ------------------------------------------------------------------

  private buildPattern(level: PatternLevel): void {
    this.patternSequence = level.pattern;
    this.required = level.pattern.length;
    this.collected = 0;
    this.timeLimit = null;

    const garden = this.add.graphics().setDepth(-5);
    garden.fillStyle(0x15803d, 0.18);
    garden.fillRect(0, 0, WIDTH, HEIGHT);

    for (const pad of level.pads) {
      const cx = pad.x * TILE + TILE / 2;
      const cy = pad.y * TILE + TILE / 2;
      const sprite = this.add
        .circle(cx, cy, 24, pad.colour, 0.9)
        .setStrokeStyle(4, 0xffffff, 0.9)
        .setDepth(2);
      this.patternPads.push({ x: pad.x, y: pad.y, colour: pad.colour, sprite });
      this.tweens.add({
        targets: sprite,
        scale: 1.06,
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }

    this.heroTile = { x: level.start.x, y: level.start.y };
    this.facing = level.start.dir;
    this.hero = this.physics.add.sprite(
      level.start.x * TILE + TILE / 2,
      level.start.y * TILE + TILE / 2,
      this.character === "girl" ? "hero-girl" : "hero-boy",
    );
    this.hero.setDisplaySize(46, 58).setDepth(5);
    this.hero.setInteractive({ useHandCursor: true });
    this.hero.on("pointerdown", () => this.triggerHeroClick());

    this.message = "Watch the flowers, then copy the pattern.";
    this.time.delayedCall(500, () => this.showPattern());
  }

  private showPattern(): void {
    if (this.status === "won" || this.status === "lost") return;
    this.patternShowing = true;
    const sequence = this.patternSequence;
    sequence.forEach((padIndex, step) => {
      this.time.delayedCall(520 + step * 620, () => {
        const pad = this.patternPads[padIndex];
        if (!pad) return;
        this.tweens.add({
          targets: pad.sprite,
          scale: 1.5,
          alpha: 1,
          duration: 220,
          yoyo: true,
          onComplete: () => pad.sprite.setScale(1),
        });
        this.playTone(440 + padIndex * 40, 0.16, "sine");
        if (step === sequence.length - 1) {
          this.time.delayedCall(500, () => {
            this.patternShowing = false;
            this.message = "Your turn: step on the flowers in the same order.";
            this.emitState(true);
          });
        }
      });
    });
  }

  private checkPatternPad(x: number, y: number): void {
    const padIndex = this.patternPads.findIndex((pad) => pad.x === x && pad.y === y);
    if (padIndex === -1) return;
    const pad = this.patternPads[padIndex];
    if (this.patternShowing) return;
    const expected = this.patternSequence[this.patternIndex];
    if (padIndex === expected) {
      this.patternIndex += 1;
      this.collected = this.patternIndex;
      this.score += 100;
      this.flashPad(pad, 0x22c55e);
      this.playTone(660 + this.patternIndex * 60, 0.12, "triangle");
      this.message = `Nice! ${this.patternIndex} of ${this.patternSequence.length} colours.`;
      if (this.patternIndex >= this.patternSequence.length) this.finishWin();
    } else {
      this.patternMistakes += 1;
      this.patternIndex = 0;
      this.collected = 0;
      this.flashPad(pad, 0xef4444);
      this.playTone(180, 0.2, "sawtooth");
      this.message = "That is a different flower. Watch the pattern and try again.";
    }
    this.emitState(true);
  }

  private flashPad(pad: { sprite: Phaser.GameObjects.Arc }, colour: number): void {
    const original = pad.sprite.fillColor;
    pad.sprite.setFillStyle(colour, 1);
    this.time.delayedCall(300, () => pad.sprite.setFillStyle(original, 0.9));
  }

  // ------------------------------------------------------------------
  // Platformer
  // ------------------------------------------------------------------

  private buildPlatformer(level: PlatformerLevel): void {
    this.physics.world.gravity.y = 1000;
    this.timeLimit = null;
    this.required = level.stars.length;
    this.respawn = { x: level.start.x, y: level.start.y };

    for (const platform of level.platforms) {
      const rect = this.add.rectangle(
        platform.x + platform.w / 2,
        platform.y + platform.h / 2,
        platform.w,
        platform.h,
        0x22c55e,
      );
      rect.setStrokeStyle(3, 0x15803d, 1);
      this.physics.add.existing(rect, true);
      this.platformRects.push(rect);
    }

    this.starsGroup = this.physics.add.staticGroup();
    for (const star of level.stars) {
      const image = this.starsGroup.create(star.x, star.y, "cb-star") as Phaser.Physics.Arcade.Image;
      image.setDisplaySize(34, 34);
      image.refreshBody();
      this.tweens.add({
        targets: image,
        y: star.y - 6,
        duration: 1000,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }

    this.flagSprite = this.add.image(level.flag.x, level.flag.y - 20, "cb-flag").setDepth(2);

    this.hero = this.physics.add.sprite(
      level.start.x,
      level.start.y,
      this.character === "girl" ? "hero-girl" : "hero-boy",
    );
    this.hero.setDisplaySize(44, 56).setDepth(5);
    this.hero.setInteractive({ useHandCursor: true });
    this.hero.on("pointerdown", () => this.triggerHeroClick());
    const body = this.hero.body as Phaser.Physics.Arcade.Body;
    body.setSize(30, 48).setOffset(7, 8);
    body.setMaxVelocity(280, 700);

    for (const rect of this.platformRects) {
      this.physics.add.collider(this.hero, rect);
    }
    if (this.starsGroup) {
      this.physics.add.overlap(this.hero, this.starsGroup, (_hero, star) => {
        const sprite = star as Phaser.Physics.Arcade.Image;
        if (!sprite.active) return;
        sprite.disableBody(true, true);
        this.collected += 1;
        this.score += 100;
        this.message = `Star collected! ${this.remaining()} to go.`;
        this.playTone(980, 0.12, "triangle");
        this.emitState(true);
      });
    }

    this.message = "Run and jump to collect the stars, then reach the flag.";
  }

  private platformerInput(): void {
    if (!this.hero || !this.cursors) return;
    if (this.isTyping()) return;
    const body = this.hero.body as Phaser.Physics.Arcade.Body;
    const left = this.cursors.left.isDown || this.wasd?.A?.isDown;
    const right = this.cursors.right.isDown || this.wasd?.D?.isDown;
    const jump = this.cursors.up.isDown || this.wasd?.W?.isDown || this.cursors.space?.isDown;

    if (left || right || jump) this.ensureStarted();
    if (left) body.setVelocityX(-190);
    else if (right) body.setVelocityX(190);
    else body.setVelocityX(body.velocity.x * 0.75);

    if (jump && body.blocked.down) {
      body.setVelocityY(-500);
      this.playTone(520, 0.08, "square");
    }
  }

  private platformerUpdate(): void {
    if (!this.hero || this.status === "won" || this.status === "lost") return;
    this.platformerInput();

    if (this.hero.y > 610) {
      this.damage(1, "You fell! Back to the start.");
      if (this.hearts > 0) {
        this.hero.setPosition(this.respawn.x, this.respawn.y);
        this.hero.setVelocity(0, 0);
      }
    }

    if (this.flagSprite && this.collected >= this.required) {
      const distance = Phaser.Math.Distance.Between(
        this.hero.x,
        this.hero.y,
        this.flagSprite.x,
        this.flagSprite.y,
      );
      if (distance < 46) {
        this.atGoal = true;
        this.finishWin();
      }
    }
  }

  // ------------------------------------------------------------------
  // Racing
  // ------------------------------------------------------------------

  private buildRacing(level: RacingLevel): void {
    this.timeLimit = level.timeLimit;
    this.timeLeft = level.timeLimit;
    this.required = level.checkpoints.length;
    this.raceCheckpoints = level.checkpoints;

    const wallRects: Phaser.GameObjects.Rectangle[] = [];
    const addWall = (x: number, y: number, w: number, h: number) => {
      const rect = this.add.rectangle(x + w / 2, y + h / 2, w, h, 0x0b1220);
      this.physics.add.existing(rect, true);
      wallRects.push(rect);
    };

    // Outer frame + inner island makes a real race ring.
    addWall(0, 0, WIDTH, 30);
    addWall(0, HEIGHT - 30, WIDTH, 30);
    addWall(0, 0, 30, HEIGHT);
    addWall(WIDTH - 30, 0, 30, HEIGHT);
    addWall(300, 150, 360, 40);
    addWall(300, 350, 360, 40);
    addWall(300, 150, 40, 240);
    addWall(620, 150, 40, 240);

    this.car = this.physics.add.sprite(level.start.x, level.start.y, "cb-car").setDepth(6);
    this.car.setDisplaySize(52, 34);
    this.car.setRotation(level.start.angle);
    this.car.setDrag(150, 150);
    this.car.setMaxVelocity(280, 280);
    const body = this.car.body as Phaser.Physics.Arcade.Body;
    body.setSize(44, 26).setOffset(4, 4);

    for (const rect of wallRects) {
      this.physics.add.collider(this.car, rect);
    }

    for (const cone of level.cones) {
      const sprite = this.physics.add.staticImage(cone.x, cone.y, "cb-cone").setDepth(3);
      sprite.setDisplaySize(30, 30);
      sprite.refreshBody();
      this.physics.add.collider(this.car, sprite, () => {
        const carBody = this.car?.body as Phaser.Physics.Arcade.Body | undefined;
        if (carBody) carBody.velocity.scale(0.45);
        this.playTone(160, 0.08, "sawtooth");
      });
    }

    this.checkpointRing = this.add.circle(level.start.x, level.start.y, 44, 0xffc300, 0.12).setDepth(1);
    const first = level.checkpoints[0];
    if (first) this.checkpointRing.setPosition(first.x, first.y);
    this.message = "Drive clockwise through the checkpoints. Watch the clock!";
  }

  private racingUpdate(): void {
    if (!this.car || this.status === "won" || this.status === "lost") return;
    if (this.isTyping()) return;
    const body = this.car.body as Phaser.Physics.Arcade.Body;

    const up = this.cursors?.up.isDown || this.wasd?.W?.isDown;
    const down = this.cursors?.down.isDown || this.wasd?.S?.isDown;
    const left = this.cursors?.left.isDown || this.wasd?.A?.isDown;
    const right = this.cursors?.right.isDown || this.wasd?.D?.isDown;

    if (up || down || left || right) this.ensureStarted();

    const angle = this.car.rotation;
    if (up) {
      body.velocity.x += Math.cos(angle) * 8;
      body.velocity.y += Math.sin(angle) * 8;
    }
    if (down) {
      body.velocity.x *= 0.94;
      body.velocity.y *= 0.94;
    }
    if (left) this.car.rotation -= 0.04;
    if (right) this.car.rotation += 0.04;

    const next = this.raceCheckpoints[this.raceNext];
    if (next) {
      const distance = Phaser.Math.Distance.Between(this.car.x, this.car.y, next.x, next.y);
      if (distance < 58) {
        this.raceNext += 1;
        this.collected = this.raceNext;
        this.score += 100;
        this.playTone(760 + this.raceNext * 60, 0.14, "triangle");
        this.message = `Checkpoint ${this.raceNext} of ${this.raceCheckpoints.length}!`;
        const following = this.raceCheckpoints[this.raceNext];
        if (following && this.checkpointRing) {
          this.checkpointRing.setPosition(following.x, following.y);
        }
        if (this.raceNext >= this.raceCheckpoints.length) {
          this.finishWin();
        }
        this.emitState(true);
      }
    }
  }

  // ------------------------------------------------------------------
  // Catcher
  // ------------------------------------------------------------------

  private buildCatcher(level: CatcherLevel): void {
    this.timeLimit = level.timeLimit;
    this.timeLeft = level.timeLimit;
    this.required = level.required;
    this.physics.world.gravity.y = level.fallSpeed;

    const moon = this.add.circle(820, 90, 54, 0xfef3c7, 0.9).setDepth(-4);
    this.tweens.add({ targets: moon, alpha: 0.7, duration: 2400, yoyo: true, repeat: -1 });

    this.basket = this.physics.add.sprite(480, 500, "cb-basket").setDepth(6);
    this.basket.setDisplaySize(100, 46);
    this.basket.setImmovable(true);
    const body = this.basket.body as Phaser.Physics.Arcade.Body;
    body.setAllowGravity(false);
    body.setSize(92, 36);

    this.fallingStars = this.physics.add.group();
    this.fallingBombs = this.physics.add.group();

    this.physics.add.overlap(this.basket, this.fallingStars, (_basket, star) => {
      const sprite = star as Phaser.Physics.Arcade.Sprite;
      if (!sprite.active) return;
      sprite.destroy();
      this.collected += 1;
      this.score += 100;
      this.message = `Caught ${this.collected} of ${this.required} stars!`;
      this.playTone(880, 0.1, "triangle");
      if (this.collected >= this.required) this.finishWin();
      this.emitState(true);
    });

    this.physics.add.overlap(this.basket, this.fallingBombs, (_basket, bomb) => {
      const sprite = bomb as Phaser.Physics.Arcade.Sprite;
      if (!sprite.active) return;
      sprite.destroy();
      this.damage(1, "A bomb cost you a heart!");
    });

    this.spawnEvent = this.time.addEvent({
      delay: level.spawnMs,
      loop: true,
      callback: () => this.spawnFallingObject(level),
    });

    this.message = "Catch the stars, dodge the bombs!";
  }

  private spawnFallingObject(level: CatcherLevel): void {
    if (this.status !== "running") return;
    if (!this.fallingStars || !this.fallingBombs) return;
    this.spawnCount += 1;
    const isBomb = level.bombEvery > 0 && this.spawnCount % level.bombEvery === 0;
    const x = Phaser.Math.Between(70, WIDTH - 70);
    if (isBomb) {
      const bomb = this.fallingBombs.create(x, -30, "cb-bomb") as Phaser.Physics.Arcade.Sprite;
      bomb.setDisplaySize(34, 38);
      bomb.setAngularVelocity(80);
    } else {
      const star = this.fallingStars.create(x, -30, "cb-star") as Phaser.Physics.Arcade.Sprite;
      star.setDisplaySize(34, 34);
      star.setAngularVelocity(60);
    }
  }

  private catcherUpdate(): void {
    if (!this.basket || this.status === "won" || this.status === "lost") return;
    if (this.isTyping()) return;
    if (!this.fallingStars || !this.fallingBombs) return;
    const left = this.cursors?.left.isDown || this.wasd?.A?.isDown;
    const right = this.cursors?.right.isDown || this.wasd?.D?.isDown;
    if (left || right) this.ensureStarted();
    if (left) this.basket.x = Math.max(60, this.basket.x - 8);
    if (right) this.basket.x = Math.min(WIDTH - 60, this.basket.x + 8);
    this.basket.setPosition(this.basket.x, 500);

    for (const child of this.fallingStars.getChildren()) {
      const sprite = child as Phaser.Physics.Arcade.Sprite;
      if (sprite.y > HEIGHT + 60) sprite.destroy();
    }
    for (const child of this.fallingBombs.getChildren()) {
      const sprite = child as Phaser.Physics.Arcade.Sprite;
      if (sprite.y > HEIGHT + 60) sprite.destroy();
    }
  }

  // ------------------------------------------------------------------
  // Game loop / shared rules
  // ------------------------------------------------------------------

  update(): void {
    if (this.cancelledFlag) return;

    if (this.status === "running" && this.timeLimit !== null && this.startedAt > 0) {
      const elapsed = (this.time.now - this.startedAt) / 1000;
      this.timeLeft = Math.max(0, this.timeLimit - elapsed);
      if (this.timeLeft <= 0) {
        this.finishLose("Time is up! Press Reset and try a faster route.");
      }
    }

    switch (this.options.level.kind) {
      case "platformer":
        this.platformerUpdate();
        break;
      case "racing":
        this.racingUpdate();
        break;
      case "catcher":
        this.catcherUpdate();
        break;
      default:
        break;
    }

    if (this.time.now - this.lastEmit > 220) this.emitState();

    if (this.spaceGlow && this.hero) {
      this.spaceGlow.setPosition(this.hero.x, this.hero.y);
    }
  }

  private beginPlay(): void {
    if (this.status === "idle") {
      this.status = "running";
      this.startedAt = this.time.now;
      if (this.timeLimit !== null) this.timeLeft = this.timeLimit;
      this.message = "Running your blocks…";
      this.emitState(true);
    }
  }

  private ensureStarted(): void {
    if (this.status === "idle") this.beginPlay();
  }

  private damage(amount: number, message: string): void {
    if (this.status === "won" || this.status === "lost") return;
    this.hearts = Math.max(0, this.hearts - amount);
    this.score = Math.max(0, this.score - 25);
    this.message = message;
    this.playTone(140, 0.18, "sawtooth");
    this.cameras.main.shake(140, 0.006);
    this.emitState(true);
    if (this.hearts <= 0) this.finishLose("You ran out of hearts. Press Reset to try again.");
  }

  private finishWin(): void {
    if (this.status === "won" || this.status === "lost") return;
    this.status = "won";
    this.cancelledFlag = true;
    this.score = Math.min(10000, this.score + 250 + this.hearts * 150);
    this.message = "Mission complete!";
    this.spawnEvent?.remove(false);
    this.playTone(660, 0.12, "triangle");
    this.time.delayedCall(120, () => this.playTone(880, 0.12, "triangle"));
    this.time.delayedCall(240, () => this.playTone(1180, 0.2, "triangle"));
    this.celebrate();
    this.emitState(true);
    this.options.onEnd(this.outcome("won"));
  }

  private finishLose(message: string): void {
    if (this.status === "won" || this.status === "lost") return;
    this.status = "lost";
    this.cancelledFlag = true;
    this.message = message;
    this.spawnEvent?.remove(false);
    this.playTone(150, 0.3, "sawtooth");
    this.emitState(true);
    this.options.onEnd(this.outcome("lost"));
  }

  private outcome(status: "won" | "lost"): RunOutcome {
    const timeTaken = this.startedAt > 0 ? Math.round((this.time.now - this.startedAt) / 1000) : 0;
    let stars = 0;
    if (status === "won") {
      stars = this.hearts >= 3 ? 3 : this.hearts === 2 ? 2 : 1;
      if (this.patternMistakes > 0) stars = Math.min(stars, 2);
      if (this.blockBudget !== undefined && this.blocksUsed > this.blockBudget) stars = 1;
    }
    return {
      status,
      score: this.score,
      stars,
      timeTaken,
      message: this.message,
      blocksUsed: this.blocksUsed,
      budget: this.blockBudget,
    };
  }

  private celebrate(): void {
    for (let i = 0; i < 14; i += 1) {
      const dot = this.add.circle(
        Phaser.Math.Between(40, WIDTH - 40),
        Phaser.Math.Between(60, HEIGHT - 80),
        4,
        i % 2 === 0 ? 0xffc300 : 0x22c55e,
        1,
      );
      this.tweens.add({
        targets: dot,
        y: dot.y - 80,
        alpha: 0,
        duration: 900 + i * 40,
        onComplete: () => dot.destroy(),
      });
    }
  }

  private setMessage(message: string): void {
    this.message = message;
    this.emitState(true);
  }

  private emitState(force = false): void {
    if (!force && this.time.now - this.lastEmit < 220) return;
    this.lastEmit = this.time.now;
    this.vars.lives = this.hearts;
    this.vars.time = this.timeLeft ?? 0;
    this.vars.collected = this.collected;
    this.vars.speed = this.speed;
    this.vars.score = this.score;
    this.options.onState(this.snapshot());
  }

  // ------------------------------------------------------------------
  // GameHost implementation
  // ------------------------------------------------------------------

  async forward(): Promise<void> {
    if (this.cancelledFlag) return;
    switch (this.options.level.kind) {
      case "grid":
      case "pattern":
        await this.stepFacing(1);
        return;
      case "platformer": {
        const body = this.hero?.body as Phaser.Physics.Arcade.Body | undefined;
        if (body) body.setVelocityX(200);
        await this.delay(380);
        if (body) body.setVelocityX(body.velocity.x * 0.4);
        return;
      }
      case "racing": {
        this.accelerateCar(120);
        await this.delay(320);
        return;
      }
      case "catcher":
        await this.moveBasket(-90);
        return;
      default:
        return;
    }
  }

  async backward(): Promise<void> {
    if (this.cancelledFlag) return;
    switch (this.options.level.kind) {
      case "grid":
      case "pattern":
        await this.stepFacing(-1);
        return;
      case "platformer": {
        const body = this.hero?.body as Phaser.Physics.Arcade.Body | undefined;
        if (body) body.setVelocityX(-150);
        await this.delay(360);
        if (body) body.setVelocityX(body.velocity.x * 0.4);
        return;
      }
      case "racing":
        this.accelerateCar(-90);
        await this.delay(320);
        return;
      case "catcher":
        await this.moveBasket(90);
        return;
      default:
        return;
    }
  }

  async left(): Promise<void> {
    if (this.cancelledFlag) return;
    switch (this.options.level.kind) {
      case "grid":
      case "pattern":
        this.facing = 2;
        await this.step(-1, 0);
        return;
      case "platformer": {
        const body = this.hero?.body as Phaser.Physics.Arcade.Body | undefined;
        if (body) body.setVelocityX(-200);
        await this.delay(380);
        if (body) body.setVelocityX(body.velocity.x * 0.4);
        return;
      }
      case "racing":
        await this.rotateCar(-0.42);
        return;
      case "catcher":
        await this.moveBasket(-90);
        return;
      default:
        return;
    }
  }

  async right(): Promise<void> {
    if (this.cancelledFlag) return;
    switch (this.options.level.kind) {
      case "grid":
      case "pattern":
        this.facing = 0;
        await this.step(1, 0);
        return;
      case "platformer": {
        const body = this.hero?.body as Phaser.Physics.Arcade.Body | undefined;
        if (body) body.setVelocityX(200);
        await this.delay(380);
        if (body) body.setVelocityX(body.velocity.x * 0.4);
        return;
      }
      case "racing":
        await this.rotateCar(0.42);
        return;
      case "catcher":
        await this.moveBasket(90);
        return;
      default:
        return;
    }
  }

  async turn(dir: "left" | "right"): Promise<void> {
    if (this.cancelledFlag) return;
    if (this.options.level.kind === "racing") {
      await this.rotateCar(dir === "left" ? -0.42 : 0.42);
      return;
    }
    if (this.options.level.kind === "grid" || this.options.level.kind === "pattern") {
      this.facing = ((this.facing + (dir === "left" ? 3 : 1)) % 4) as 0 | 1 | 2 | 3;
      const angle = [0, Math.PI / 2, Math.PI, -Math.PI / 2][this.facing];
      if (this.hero) this.hero.setRotation(angle * 0.18);
      this.playTone(440, 0.05, "sine");
      this.emitState(true);
      await this.delay(90);
    }
  }

  async jump(): Promise<void> {
    if (this.cancelledFlag) return;
    if (this.options.level.kind === "platformer") {
      const body = this.hero?.body as Phaser.Physics.Arcade.Body | undefined;
      if (body?.blocked.down) {
        body.setVelocityY(-500);
        this.playTone(520, 0.08, "square");
      }
      await this.delay(420);
      return;
    }
    if (this.options.level.kind === "grid" || this.options.level.kind === "pattern") {
      if (!this.hero) return;
      const baseY = this.hero.y;
      await this.awaitTween(this.hero, this.hero.x, baseY - 24, 130);
      await this.awaitTween(this.hero, this.hero.x, baseY, 130);
      this.emitState(true);
      return;
    }
    if (this.options.level.kind === "catcher") {
      await this.delay(120);
    }
  }

  async brake(): Promise<void> {
    if (this.options.level.kind === "racing" && this.car) {
      const body = this.car.body as Phaser.Physics.Arcade.Body;
      body.velocity.scale(0.4);
    }
    await this.delay(140);
  }

  async setSpeed(value: number): Promise<void> {
    this.speed = value;
    this.vars.speed = value;
    this.emitState(true);
    await this.delay(40);
  }

  async goto(x: number, y: number): Promise<void> {
    const level = this.options.level;
    if ((level.kind === "grid" || level.kind === "pattern") && this.hero) {
      if (this.gridWalls.has(`${x},${y}`)) {
        this.setMessage("That tile is blocked.");
        return;
      }
      this.heroTile = { x, y };
      this.hero.setPosition(x * TILE + TILE / 2, y * TILE + TILE / 2);
      this.enterTile(x, y);
      return;
    }
    if (level.kind === "platformer" && this.hero) {
      this.hero.setPosition(x * TILE, y * TILE);
      return;
    }
    if (level.kind === "catcher" && this.basket) {
      this.basket.x = Phaser.Math.Clamp(x * TILE, 60, WIDTH - 60);
    }
    await this.delay(60);
  }

  async wait(seconds: number): Promise<void> {
    await this.delay(seconds * 1000);
  }

  async say(text: string): Promise<void> {
    if (!this.hero) {
      this.setMessage(text);
      return;
    }
    const bubble = this.add
      .text(this.hero.x, this.hero.y - 54, text.slice(0, 60), {
        fontFamily: "Nunito, system-ui, sans-serif",
        fontSize: "16px",
        color: "#062d58",
        backgroundColor: "#ffffff",
        padding: { x: 8, y: 5 },
        wordWrap: { width: 220 },
      })
      .setOrigin(0.5, 1)
      .setDepth(20);
    this.time.delayedCall(1800, () => bubble.destroy());
    await this.delay(320);
  }

  async setVisible(visible: boolean): Promise<void> {
    this.hero?.setVisible(visible);
    await this.delay(60);
  }

  async setSize(percent: number): Promise<void> {
    if (this.hero) {
      const scale = percent / 100;
      this.hero.setDisplaySize(46 * scale, 58 * scale);
    }
    await this.delay(60);
  }

  async setCostume(name: string): Promise<void> {
    if (name === "girl" || name === "boy") {
      this.applyCharacter(name);
    }
    await this.delay(60);
  }

  async playSound(action: string): Promise<void> {
    if (action === "beep") this.playTone(520, 0.12, "sine");
    else if (action === "chime") {
      this.playTone(660, 0.12, "sine");
      this.time.delayedCall(110, () => this.playTone(880, 0.16, "sine"));
    } else if (action === "coin") {
      this.playTone(880, 0.1, "triangle");
      this.time.delayedCall(90, () => this.playTone(1320, 0.14, "triangle"));
    } else if (action === "whoosh") {
      this.playTone(240, 0.22, "sawtooth");
    } else if (action === "effect:sparkle") {
      [880, 1100, 1320].forEach((freq, index) =>
        this.time.delayedCall(index * 90, () => this.playTone(freq, 0.1, "sine")),
      );
    } else if (action === "effect:flash") {
      this.cameras.main.flash(160, 255, 255, 255);
    }
    await this.delay(80);
  }

  getVariable(name: string): number {
    if (name === "lives") return this.hearts;
    if (name === "time") return Math.round(this.timeLeft ?? 0);
    if (name === "collected") return this.collected;
    if (name === "speed") return this.speed;
    if (name === "score") return this.score;
    return this.vars[name] ?? 0;
  }

  setVariable(name: string, value: number): void {
    this.vars[name] = value;
    if (name === "speed") this.speed = Phaser.Math.Clamp(value, 1, 10);
    if (name === "lives") this.hearts = Math.max(0, Math.round(value));
    this.emitState(true);
  }

  sense(name: string, arg?: string): number | boolean {
    switch (name) {
      case "hazard":
        return this.time.now < this.hazardUntil;
      case "goal":
        if (this.options.level.kind === "grid") {
          return this.heroTile.x === this.gridGoal.x && this.heroTile.y === this.gridGoal.y;
        }
        if (this.options.level.kind === "platformer") return this.atGoal;
        if (this.options.level.kind === "racing") return this.raceNext >= this.raceCheckpoints.length;
        if (this.options.level.kind === "catcher") return this.collected >= this.required;
        return this.patternIndex >= this.patternSequence.length;
      case "collected":
        return this.collected;
      case "hearts":
        return this.hearts;
      case "time":
        return Math.round(this.timeLeft ?? 0);
      case "enemy": {
        if (this.options.level.kind === "grid") {
          const radius = 2;
          for (let dx = -radius; dx <= radius; dx += 1) {
            for (let dy = -radius; dy <= radius; dy += 1) {
              if (this.gridHazards.has(`${this.heroTile.x + dx},${this.heroTile.y + dy}`)) return true;
            }
          }
          return false;
        }
        return false;
      }
      case "key":
        return Boolean(arg && this.keyState[arg]);
      default:
        return 0;
    }
  }

  notice(message: string): void {
    this.setMessage(message);
  }

  cancelled(): boolean {
    return this.cancelledFlag;
  }

  // ------------------------------------------------------------------
  // Low-level helpers
  // ------------------------------------------------------------------

  private stepFacing(direction: 1 | -1): Promise<void> {
    const delta = [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 0, y: -1 },
    ][this.facing];
    return this.step(delta.x * direction, delta.y * direction);
  }

  private accelerateCar(amount: number): void {
    if (!this.car) return;
    const body = this.car.body as Phaser.Physics.Arcade.Body;
    const angle = this.car.rotation;
    body.velocity.x += Math.cos(angle) * amount;
    body.velocity.y += Math.sin(angle) * amount;
    const max = 280;
    if (body.velocity.length() > max) body.velocity.normalize().scale(max);
  }

  private async rotateCar(amount: number): Promise<void> {
    if (!this.car) return;
    const steps = 8;
    const each = amount / steps;
    for (let i = 0; i < steps; i += 1) {
      if (this.cancelledFlag) return;
      this.car.rotation += each;
      await this.delay(22);
    }
  }

  private async moveBasket(dx: number): Promise<void> {
    if (!this.basket) return;
    const start = this.basket.x;
    const target = Phaser.Math.Clamp(start + dx, 60, WIDTH - 60);
    await this.awaitTween(this.basket, target, 500, 260);
  }

  private awaitTween(
    target: Phaser.GameObjects.GameObject,
    x: number,
    y: number,
    duration: number,
  ): Promise<void> {
    if (this.cancelledFlag) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.pending.push(finish);
      this.tweens.add({
        targets: target,
        x,
        y,
        duration,
        ease: "Sine.easeInOut",
        onComplete: finish,
        onStop: finish,
      });
    });
  }

  private delay(ms: number): Promise<void> {
    if (this.cancelledFlag || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.pending.push(finish);
      this.time.delayedCall(ms, finish);
    });
  }

  private setupKeyboard(): void {
    const keyboard = this.input.keyboard;
    if (!keyboard) return;
    this.cursors = keyboard.addKeys({up:'UP',down:'DOWN',left:'LEFT',right:'RIGHT',space:'SPACE',shift:'SHIFT'},false) as Phaser.Types.Input.Keyboard.CursorKeys;
    this.wasd = keyboard.addKeys("W,A,S,D",false) as Record<string, Phaser.Input.Keyboard.Key>;

    this.keyHandler = (event: KeyboardEvent) => {
      if (event.repeat || this.isTyping()) return;
      const key = this.normaliseKey(event.key);
      if (key) this.keyState[key] = true;
      if (this.status === "won" || this.status === "lost") return;

      if (this.keyStatements.length > 0 && !this.running) {
        void this.startEvent(this.keyStatements, this.eventFunctions);
      }

      if (this.options.level.kind === "grid" || this.options.level.kind === "pattern") {
        const map: Record<string, { x: number; y: number }> = {
          arrowup: { x: 0, y: -1 },
          w: { x: 0, y: -1 },
          arrowdown: { x: 0, y: 1 },
          s: { x: 0, y: 1 },
          arrowleft: { x: -1, y: 0 },
          a: { x: -1, y: 0 },
          arrowright: { x: 1, y: 0 },
          d: { x: 1, y: 0 },
        };
        const delta = map[event.key.toLowerCase()];
        if (delta) {
          event.preventDefault();
          this.facing =
            delta.x === 1 ? 0 : delta.x === -1 ? 2 : delta.y === 1 ? 1 : 3;
          void this.step(delta.x, delta.y);
        }
      }
      if (event.key === " " && this.options.level.kind === "platformer") {
        event.preventDefault();
        void this.jump();
      }
    };
    keyboard.on("keydown", this.keyHandler);
    this.keyUpHandler = (event: KeyboardEvent) => {
      const key = this.normaliseKey(event.key);
      if (key) this.keyState[key] = false;
    };
    keyboard.on("keyup", this.keyUpHandler);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      if (this.keyHandler) keyboard.off("keydown", this.keyHandler);
      if (this.keyUpHandler) keyboard.off("keyup", this.keyUpHandler);
    });

  }

  private isTyping(): boolean {
    return Boolean(document.activeElement?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
  }

  private normaliseKey(key: string): string | null {
    const lower = key.toLowerCase();
    if (lower === " " || lower === "spacebar") return "space";
    if (lower === "arrowup" || lower === "w") return "up";
    if (lower === "arrowdown" || lower === "s") return "down";
    if (lower === "arrowleft" || lower === "a") return "left";
    if (lower === "arrowright" || lower === "d") return "right";
    if (lower === "enter") return "enter";
    return null;
  }

  private playTone(frequency: number, duration: number, type: OscillatorType): void {
    if (!this.soundEnabled) return;
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const context = new Ctor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.06, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + duration);
      oscillator.onended = () => void context.close();
    } catch {
      /* Sound is a nicety; never let it break the game. */
    }
  }
}
