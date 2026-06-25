// Pixel-art cat overlay — transparent canvas on top of the running visualizer.
// Beat/tempo info comes from AudioEngine.getBeatInfo(), not Spotify.

const SPRITE_SIZE = 16;
const SCALE       = 5;
const MOVE_COUNT  = 5;

// [transparent, body, dark, stripe, face, eye, nosePink, belly, outline]
const PALETTES = [
  [null, '#E8A44A', '#C07830', '#8B5A1A', '#F0C070', '#3A7A3A', '#E87878', '#F5E0A8', '#3A1A00'],
  [null, '#909090', '#606060', '#404040', '#C0C0C0', '#4A80C0', '#E87878', '#E8E8E8', '#202020'],
  [null, '#282828', '#101010', '#181818', '#404040', '#FFD700', '#D07070', '#E8E8E8', '#000000'],
  [null, '#F0F0F0', '#D0D0D0', '#E07030', '#FFFFFF', '#228B22', '#E87878', '#FFFFFF', '#303030'],
  [null, '#F0F0F0', '#D8D8D8', '#E0E0E0', '#FFFFFF', '#7BA8D8', '#E8A0A0', '#FFFFFF', '#A8A8A8'],
];

// 3 frames: NEUTRAL(0), ARMS_UP(1), CROUCH(2)
// Palette indices: 0=transparent 1=body 2=dark 3=stripe 4=face 5=eye 6=nosePink 7=belly 8=outline
const FRAMES = [
  // Frame 0: NEUTRAL
  [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,8,8,0,0,0,0,8,8,0,0,0,0],
    [0,0,0,8,1,6,8,0,0,8,6,1,8,0,0,0],
    [0,0,0,8,1,1,1,8,8,1,1,1,8,0,0,0],
    [0,0,0,8,4,4,4,4,4,4,4,4,8,0,0,0],
    [0,0,0,8,4,5,5,4,4,5,5,4,8,0,0,0],
    [0,0,0,8,4,4,4,6,6,4,4,4,8,0,0,0],
    [0,0,0,0,8,1,1,1,1,1,1,8,0,0,0,0],
    [0,0,0,0,8,1,7,7,7,7,1,8,0,0,0,0],
    [0,0,0,8,1,1,7,7,7,7,1,1,8,0,0,0],
    [0,0,0,8,1,1,7,7,7,7,1,1,8,0,0,0],
    [0,0,0,8,1,3,1,1,1,1,3,1,8,0,0,0],
    [0,0,0,8,1,1,1,1,1,1,1,1,8,0,0,0],
    [0,0,0,0,8,1,8,0,0,8,1,8,0,0,0,0],
    [0,0,0,0,8,1,8,0,0,8,1,8,0,0,0,0],
    [0,0,0,0,8,8,0,0,0,0,8,8,0,0,0,0],
  ],
  // Frame 1: ARMS_UP (paws raised sideways on beat hit)
  [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,8,8,0,0,0,0,8,8,0,0,0,0],
    [0,0,0,8,1,6,8,0,0,8,6,1,8,0,0,0],
    [0,0,0,8,1,1,1,8,8,1,1,1,8,0,0,0],
    [0,0,0,8,4,4,4,4,4,4,4,4,8,0,0,0],
    [0,0,0,8,4,5,5,4,4,5,5,4,8,0,0,0],
    [0,0,0,8,4,4,4,6,6,4,4,4,8,0,0,0],
    [0,0,0,0,8,1,1,1,1,1,1,8,0,0,0,0],
    [0,0,8,1,8,1,7,7,7,7,1,8,1,8,0,0],
    [0,0,8,1,1,1,7,7,7,7,1,1,1,8,0,0],
    [0,0,0,8,1,1,7,7,7,7,1,1,8,0,0,0],
    [0,0,0,8,1,3,1,1,1,1,3,1,8,0,0,0],
    [0,0,0,8,1,1,1,1,1,1,1,1,8,0,0,0],
    [0,0,0,0,8,1,8,0,0,8,1,8,0,0,0,0],
    [0,0,0,0,8,1,8,0,0,8,1,8,0,0,0,0],
    [0,0,0,0,8,8,0,0,0,0,8,8,0,0,0,0],
  ],
  // Frame 2: CROUCH (head shifted down 1, body wide and squashed)
  [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,8,8,0,0,0,0,8,8,0,0,0,0],
    [0,0,0,8,1,6,8,0,0,8,6,1,8,0,0,0],
    [0,0,0,8,1,1,1,8,8,1,1,1,8,0,0,0],
    [0,0,0,8,4,4,4,4,4,4,4,4,8,0,0,0],
    [0,0,0,8,4,5,5,4,4,5,5,4,8,0,0,0],
    [0,0,0,8,4,4,4,6,6,4,4,4,8,0,0,0],
    [0,0,0,0,8,1,1,1,1,1,1,8,0,0,0,0],
    [0,0,8,1,1,1,7,7,7,7,1,1,1,8,0,0],
    [0,0,8,1,1,7,7,7,7,7,7,1,1,8,0,0],
    [0,0,8,1,3,1,7,7,7,7,1,3,1,8,0,0],
    [0,0,8,1,1,1,1,1,1,1,1,1,1,8,0,0],
    [0,0,0,8,1,8,0,0,0,0,8,1,8,0,0,0],
    [0,0,0,8,8,0,0,0,0,0,0,8,8,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  ],
];

function renderSprite(frame, palette) {
  const S  = SPRITE_SIZE;
  const oc = document.createElement('canvas');
  oc.width  = S * SCALE;
  oc.height = S * SCALE;
  const ctx = oc.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) {
      const idx = frame[r][c];
      if (idx === 0) continue;
      ctx.fillStyle = palette[idx];
      ctx.fillRect(c * SCALE, r * SCALE, SCALE, SCALE);
    }
  }
  return oc;
}

export class CatMode {
  constructor(canvas) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.active   = false;
    this.cats     = [];
    this._sprites = PALETTES.map(p => FRAMES.map(f => renderSprite(f, p)));
    this._resize();
    this.setCatCount(4);
  }

  enable() {
    this.active = true;
    this._resize();
    this._layoutCats();
  }

  disable() {
    this.active = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  setCatCount(n) {
    const count = Math.max(1, Math.min(8, n));
    this.cats = Array.from({ length: count }, (_, i) => ({
      variant:      i % PALETTES.length,
      move:         Math.floor(Math.random() * MOVE_COUNT),
      moveDuration: 4 + Math.floor(Math.random() * 5),
      beatCount:    0,
      x: 0,
      y: 0,
    }));
    this._layoutCats();
  }

  onBeat()        { /* beat info arrives via tick() now */ }
  onTrackChange() {
    for (const cat of this.cats) {
      cat.move         = Math.floor(Math.random() * MOVE_COUNT);
      cat.moveDuration = 4 + Math.floor(Math.random() * 5);
      cat.beatCount    = 0;
    }
  }

  tick(timestamp, beatInfo) {
    if (!this.active) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const cat of this.cats) {
      if (beatInfo.isBeat) {
        cat.beatCount++;
        if (cat.beatCount >= cat.moveDuration) {
          cat.move         = Math.floor(Math.random() * MOVE_COUNT);
          cat.moveDuration = 4 + Math.floor(Math.random() * 5);
          cat.beatCount    = 0;
        }
      }
      this._drawCat(cat, beatInfo);
    }
  }

  _resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  _layoutCats() {
    const S = SPRITE_SIZE * SCALE;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const n = this.cats.length;
    const y = H - S - 20;
    this.cats.forEach((cat, i) => {
      cat.x = Math.round(W * (i + 1) / (n + 1) - S / 2);
      cat.y = y;
    });
  }

  _drawCat(cat, { bass, beatPhase }) {
    const S    = SPRITE_SIZE * SCALE;
    const half = S / 2;

    // Arms-up briefly on beat hit, neutral otherwise
    const frameIdx = beatPhase < 0.25 ? 1 : 0;
    const sprite   = this._sprites[cat.variant][frameIdx];
    const ctx      = this.ctx;

    let dx = 0, dy = 0, angle = 0;

    switch (cat.move) {
      case 0: // bounce — jump up on beat, gravity returns
        dy = -Math.sin(beatPhase * Math.PI) * (8 + bass * 24);
        break;
      case 1: // sidestep — left/right full cycle per beat
        dx = Math.sin(beatPhase * Math.PI * 2) * (12 + bass * 18);
        break;
      case 2: // spin — full rotation per beat
        angle = beatPhase * Math.PI * 2;
        break;
      case 3: // headbang — forward nod with lean
        dy    = -(1 - beatPhase) * (1 - beatPhase) * bass * 20;
        angle = Math.sin(beatPhase * Math.PI) * (0.35 + bass * 0.3);
        break;
      case 4: // wiggle — rapid high-frequency shake
        angle = Math.sin(beatPhase * Math.PI * 6) * (0.2 + bass * 0.25);
        break;
    }

    if (angle !== 0) {
      ctx.save();
      ctx.translate(cat.x + dx + half, cat.y + dy + half);
      ctx.rotate(angle);
      ctx.drawImage(sprite, -half, -half);
      ctx.restore();
    } else {
      ctx.drawImage(sprite, Math.round(cat.x + dx), Math.round(cat.y + dy));
    }
  }
}
