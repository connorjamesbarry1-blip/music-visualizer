// Pixel-art cat overlay — "Kitty Party Time"
// Beat/tempo info comes from AudioEngine.getBeatInfo(), not Spotify.
// Features: 11 dance types, roaming, speed control, up to 100 cats.

const SPRITE_SIZE = 16;
const SCALE       = 5;
const DANCE_COUNT = 11;

// Dance type name → index mapping
const DANCE_NAMES = [
  'bounce',    // 0
  'sidestep',  // 1
  'spin',      // 2
  'headbang',  // 3
  'wiggle',    // 4
  'backflip',  // 5
  'moonwalk',  // 6
  'twerk',     // 7
  'macarena',  // 8
  'wave',      // 9
  'random',    // 10 — picks randomly per phrase
];

// [transparent, body, dark, stripe, face, eye, nosePink, belly, outline]
const PALETTES = [
  [null, '#E8A44A', '#C07830', '#8B5A1A', '#F0C070', '#3A7A3A', '#E87878', '#F5E0A8', '#3A1A00'],
  [null, '#909090', '#606060', '#404040', '#C0C0C0', '#4A80C0', '#E87878', '#E8E8E8', '#202020'],
  [null, '#282828', '#101010', '#181818', '#404040', '#FFD700', '#D07070', '#E8E8E8', '#000000'],
  [null, '#F0F0F0', '#D0D0D0', '#E07030', '#FFFFFF', '#228B22', '#E87878', '#FFFFFF', '#303030'],
  [null, '#F0F0F0', '#D8D8D8', '#E0E0E0', '#FFFFFF', '#7BA8D8', '#E8A0A0', '#FFFFFF', '#A8A8A8'],
  [null, '#FF8C00', '#CC6600', '#994D00', '#FFB366', '#006400', '#FF6B6B', '#FFE0B2', '#663300'],
  [null, '#B0B0FF', '#8080D0', '#5050A0', '#D0D0FF', '#FF4444', '#FFB0B0', '#E8E8FF', '#303060'],
  [null, '#FFB6C1', '#FF69B4', '#FF1493', '#FFD1DC', '#8B4513', '#FF0000', '#FFFFFF', '#8B0000'],
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
    this._roaming     = false;
    this._roamSpeed   = 50;    // 10–200 percent scale
    this._danceType   = 'random';
    this._lastTs      = 0;
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

  setDanceType(type) {
    this._danceType = type;
    // If a specific dance is chosen, apply it to all cats immediately
    if (type !== 'random') {
      const idx = DANCE_NAMES.indexOf(type);
      if (idx >= 0) {
        for (const cat of this.cats) cat.move = idx;
      }
    }
  }

  setRoaming(on) {
    this._roaming = on;
    if (on) {
      // Give each cat a random velocity
      for (const cat of this.cats) {
        const angle = Math.random() * Math.PI * 2;
        cat.vx = Math.cos(angle) * 40;
        cat.vy = Math.sin(angle) * 40;
      }
    }
    this._layoutCats();
  }

  setRoamSpeed(pct) {
    this._roamSpeed = Math.max(10, Math.min(200, pct));
  }

  setCatCount(n) {
    const count = Math.max(1, Math.min(100, n));
    this.cats = Array.from({ length: count }, (_, i) => ({
      variant:       i % PALETTES.length,
      move:          this._danceType === 'random'
                       ? Math.floor(Math.random() * (DANCE_COUNT - 1))
                       : Math.max(0, DANCE_NAMES.indexOf(this._danceType)),
      moveDuration:  Math.random() < 0.5 ? 4 : 8,
      gridBeatCount: 0,
      x: 0,
      y: 0,
      vx: (Math.random() - 0.5) * 80,
      vy: (Math.random() - 0.5) * 80,
    }));
    this._layoutCats();
  }

  onBeat() { /* beat info arrives via tick() now */ }
  onTrackChange() {
    for (const cat of this.cats) {
      if (this._danceType === 'random') {
        cat.move = Math.floor(Math.random() * (DANCE_COUNT - 1));
      }
      cat.moveDuration  = Math.random() < 0.5 ? 4 : 8;
      cat.gridBeatCount = 0;
    }
  }

  tick(timestamp, beatInfo) {
    if (!this.active) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const dt = Math.min((timestamp - this._lastTs) / 1000, 0.1) || 0.016;
    this._lastTs = timestamp;

    for (const cat of this.cats) {
      // Advance move on the grid clock
      if (beatInfo.gridBeat) {
        cat.gridBeatCount++;
        if (cat.gridBeatCount >= cat.moveDuration) {
          if (this._danceType === 'random') {
            cat.move = Math.floor(Math.random() * (DANCE_COUNT - 1));
          }
          cat.moveDuration  = Math.random() < 0.5 ? 4 : 8;
          cat.gridBeatCount = 0;
        }
      }

      // Roaming movement
      if (this._roaming) {
        const speedFactor = this._roamSpeed / 50; // normalise around 50%
        cat.x += cat.vx * speedFactor * dt;
        cat.y += cat.vy * speedFactor * dt;

        const S = SPRITE_SIZE * SCALE;
        // Bounce off edges
        if (cat.x < 0)                       { cat.x = 0;                       cat.vx = Math.abs(cat.vx); }
        if (cat.x > this.canvas.width - S)   { cat.x = this.canvas.width - S;   cat.vx = -Math.abs(cat.vx); }
        if (cat.y < 0)                       { cat.y = 0;                       cat.vy = Math.abs(cat.vy); }
        if (cat.y > this.canvas.height - S)  { cat.y = this.canvas.height - S;  cat.vy = -Math.abs(cat.vy); }

        // Small random nudge to keep things lively
        cat.vx += (Math.random() - 0.5) * 8 * dt;
        cat.vy += (Math.random() - 0.5) * 8 * dt;
        // Clamp speed
        const maxV = 120 * speedFactor;
        const v = Math.sqrt(cat.vx * cat.vx + cat.vy * cat.vy);
        if (v > maxV) { cat.vx *= maxV / v; cat.vy *= maxV / v; }
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

    if (this._roaming) {
      // Scatter randomly across screen
      for (const cat of this.cats) {
        cat.x = Math.random() * (W - S);
        cat.y = Math.random() * (H - S);
      }
    } else {
      // Line up along bottom, wrapping into rows if needed
      const maxPerRow = Math.max(1, Math.floor(W / (S + 10)));
      const rows = Math.ceil(n / maxPerRow);
      this.cats.forEach((cat, i) => {
        const row    = Math.floor(i / maxPerRow);
        const col    = i % maxPerRow;
        const inRow  = Math.min(maxPerRow, n - row * maxPerRow);
        cat.x = Math.round(W * (col + 1) / (inRow + 1) - S / 2);
        cat.y = H - S - 20 - row * (S + 8);
      });
    }
  }

  _drawCat(cat, { kick, isKick, beatPhase }) {
    const S    = SPRITE_SIZE * SCALE;
    const half = S / 2;

    // Arms-up on the grid beat onset; neutral during the rest of the beat
    const frameIdx = beatPhase < 0.25 ? 1 : 0;
    const sprite   = this._sprites[cat.variant][frameIdx];
    const ctx      = this.ctx;

    // Real kick punch: extra amplitude boost that decays within the beat
    const accent = isKick ? (1 + kick * 1.5) : 1.0;
    const amp = kick;

    let dx = 0, dy = 0, angle = 0, scaleX = 1, scaleY = 1;

    switch (cat.move) {
      case 0: // bounce — jump arc driven by grid phase
        dy = -Math.sin(beatPhase * Math.PI) * (8 + amp * 24) * accent;
        break;
      case 1: // sidestep — sinusoidal L/R
        dx = Math.sin(beatPhase * Math.PI * 2) * (12 + amp * 18) * accent;
        break;
      case 2: // spin — full rotation per beat
        angle = beatPhase * Math.PI * 2;
        break;
      case 3: // headbang — nod into the beat, snap back
        dy    = -(1 - beatPhase) * (1 - beatPhase) * amp * 20 * accent;
        angle = Math.sin(beatPhase * Math.PI) * (0.35 + amp * 0.3);
        break;
      case 4: // wiggle — rapid high-freq shake
        angle = Math.sin(beatPhase * Math.PI * 6) * (0.2 + amp * 0.25) * accent;
        break;
      case 5: // backflip — slow arc up + continuous rotation
        dy    = -Math.sin(beatPhase * Math.PI) * (30 + amp * 35) * accent;
        angle = beatPhase * Math.PI * 2 * 1.5; // 1.5 rotations per beat
        break;
      case 6: // moonwalk — smooth glide sideways + slight lean
        dx    = Math.cos(beatPhase * Math.PI * 2) * (20 + amp * 25) * accent;
        angle = Math.sin(beatPhase * Math.PI * 2) * 0.12;
        scaleX = -1; // face backwards for moonwalk effect
        break;
      case 7: // twerk — quick crouch-bounce with horizontal oscillation
        dy    = Math.abs(Math.sin(beatPhase * Math.PI * 3)) * (6 + amp * 12) * accent;
        scaleY = 1 - Math.abs(Math.sin(beatPhase * Math.PI * 3)) * 0.15;
        dx    = Math.sin(beatPhase * Math.PI * 4) * (4 + amp * 8);
        break;
      case 8: // macarena — staged arm motions approximated with tilts + shifts
        {
          const phase4 = (beatPhase * 4) % 1;
          const stage  = Math.floor(beatPhase * 4);
          switch (stage) {
            case 0: dx =  (10 + amp * 8) * phase4; break;             // reach right
            case 1: dx = -(10 + amp * 8) * phase4; break;             // reach left
            case 2: angle =  (0.3 + amp * 0.2) * Math.sin(phase4 * Math.PI); break; // twist
            case 3: dy = -Math.sin(phase4 * Math.PI) * (12 + amp * 15); break;      // jump
          }
        }
        break;
      case 9: // wave — gentle sinusoidal sway (side-to-side + up-down)
        dx    = Math.sin(beatPhase * Math.PI * 2) * (14 + amp * 10) * accent;
        dy    = Math.sin(beatPhase * Math.PI * 4) * (5 + amp * 6);
        angle = Math.sin(beatPhase * Math.PI * 2) * (0.15 + amp * 0.1);
        break;
      default: // fallback to bounce
        dy = -Math.sin(beatPhase * Math.PI) * (8 + amp * 24) * accent;
    }

    ctx.save();
    ctx.translate(cat.x + dx + half, cat.y + dy + half);
    if (angle !== 0) ctx.rotate(angle);
    if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
    ctx.drawImage(sprite, -half, -half);
    ctx.restore();
  }
}
