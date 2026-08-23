  FM_BAND_MIN, FM_BAND_MAX, DIAL_SALT, DIAL_BRANDS,
  dialCanvasSize, dialBrandFor, needleXFor, dialRestFreq,
  paintDial, paintDialLit, paintDialInto,
} = mod;

// ---------------------------------------------------------------------------
// Recording 2D-context stub
// ---------------------------------------------------------------------------
class GradientStub {
  constructor(kind, args) { this.kind = kind; this.args = args; this.stops = []; }
  addColorStop(t, color) { this.stops.push([t, color]); }
}

class RecordingCtx {
  constructor() {
    this.ops = [];
    this.font = '';
    this.textAlign = '';
    this.textBaseline = '';
    this.fillStyle = '';
    this.strokeStyle = '';
    this.lineWidth = 1;
    this.shadowColor = '';
    this.shadowBlur = 0;
    this.saveCount = 0;
    this.restoreCount = 0;
  }
  _rec(name, args) {
    this.ops.push({ op: name, args: [...args], style: this.fillStyle, stroke: this.strokeStyle });
  }
  save() { this.saveCount++; this._rec('save', []); }
  restore() { this.restoreCount++; this._rec('restore', []); }
  fillRect(...a) { this._rec('fillRect', a); }
  strokeRect(...a) { this._rec('strokeRect', a); }
  beginPath() { this._rec('beginPath', []); }
  closePath() { this._rec('closePath', []); }
  moveTo(...a) { this._rec('moveTo', a); }
  lineTo(...a) { this._rec('lineTo', a); }
  arc(...a) { this._rec('arc', a); }
  fill() { this._rec('fill', []); }
  stroke() { this._rec('stroke', []); }
  fillText(...a) { this._rec('fillText', a); }
  createLinearGradient(...a) { return new GradientStub('linear', a); }
  createRadialGradient(...a) { return new GradientStub('radial', a); }
}

function paint(variant, seed, w = 512, h = 256, freq) {
  const ctx = new RecordingCtx();
  if (variant === 'lit') paintDialLit(ctx, w, h, seed, freq);
  else if (variant === 'dim') paintDial(ctx, w, h, seed, freq);
  else paintDialInto(ctx, w, h, seed, variant);
  return ctx;
}

const traceOf = (ctx) => JSON.stringify(ctx.ops);

// ---------------------------------------------------------------------------
 // Constants and canvas spec
// ---------------------------------------------------------------------------
check('band constants are 88/108 MHz', FM_BAND_MIN === 88 && FM_BAND_MAX === 108,
  FM_BAND_MIN + '/' + FM_BAND_MAX);
check('two brands declared HALCYON and REGENCY',
  DIAL_BRANDS.length === 2 && DIAL_BRANDS.includes('HALCYON') && DIAL_BRANDS.includes('REGENCY'),
  JSON.stringify(DIAL_BRANDS));

{
  const { width, height } = dialCanvasSize();
  check('canvas size positive ints, landscape, multiple of 4',
    Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width > height && width % 4 === 0 && height % 4 === 0,


