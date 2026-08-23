/**
 * Full note rendering - textured paper + handwriting composed onto one
 * offscreen canvas ready for a THREE.DynamicTexture.
 *
 * This is the integration layer over notepaper.ts: NotePaper supplies the
 * procedural paper texture and the handwriting treatments; NotePaperMesher
 * sizes an offscreen canvas, paints the texture scaled to the note quad,
 * word-wraps the note body to the writable area, and draws the text in the
 * handwriting style assigned to that note id.
 *
 * Determinism contract:
 *  - the (paperType, handStyle) pair comes from NotePaper.styleFor(), a pure
 *    hash of the note id;
 *  - every random jitter inside the handwriting painter is seeded from the
 *    drawn text itself;
 *  - therefore render(noteId, text, w, h) produces pixel-identical output for
 *    identical arguments, across saves, sessions and reloads.
 *
 * Performance contract:
 *  - no external images, no font loading, pure canvas work;
 *  - paper textures are generated once by NotePaper's cache and merely
 *    blitted here, so repeated renders cost one drawImage + text passes.
 */

import {
  NotePaper,
} from './notepaper';

/* ------------------------------------------------------------------ *
 * Line wrapping
 * ------------------------------------------------------------------ */

/**
 * Word-wrap plain text to a maximum pixel width.
 *
 * Rules:
 *  - explicit newlines always break and blank lines are preserved;
 *  - runs of whitespace collapse to single spaces between words;
 *  - a word wider than maxWidth is hard-broken at the character that
 *    overflows (notes never lose text just because one token is huge).
 *
 * Returns the list of wrapped lines; an empty input yields [''].
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  const paragraphs = String(text ?? '').split('\n');

  for (const para of paragraphs) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }

    if (!(maxWidth > 0)) {
      out.push(para.replace(/\s+/g, ' ').trim());
      continue;
    }

    const words = para.split(/\s+/).filter((w) => w.length > 0);
    let cur = '';

    for (const word of words) {
      const candidate = cur === '' ? word : cur + ' ' + word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        cur = candidate;
        continue;
      }
      // Overflow: flush what we have, then place the word on its own line -
      // hard-breaking it further if even a lone word cannot fit.
      if (cur !== '') {
        out.push(cur);
        cur = '';
      }
      if (ctx.measureText(word).width > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          if (chunk !== '' && ctx.measureText(chunk + ch).width > maxWidth) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        cur = chunk;
      } else {
        cur = word;
      }
    }

    out.push(cur);
  }

  return out.length > 0 ? out : [''];
}

/* ------------------------------------------------------------------ *
 * Mesher
 * ------------------------------------------------------------------ */

function makeCanvas(): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new Error('notepaper-mesher: no DOM');
  return document.createElement('canvas');
}

/** Layout knobs derived from the requested canvas size. */
interface Layout {
  padX: number;
  padTop: number;
  fontSize: number;
  lineHeight: number;
}

function layoutFor(w: number, h: number): Layout {
  const padX = Math.max(8, Math.round(w * 0.09));
  const padTop = Math.max(10, Math.round(h * 0.11));
  const fontSize = Math.max(9, Math.round(h * 0.065));
  const lineHeight = fontSize * 1.35;
  return { padX, padTop, fontSize, lineHeight };
}

export class NotePaperMesher {
  /**
   * Render a complete readable note: paper texture background plus the note
   * body in the handwriting style bound to noteId. Returns an offscreen
   * canvas of exactly w x h, ready to back a DynamicTexture.
   *
   * Text longer than the page simply runs off the bottom edge - notes are
   * physical scraps, not scrollable documents - but every line that fits is
   * drawn, wrapped to the writable area between the margins.
   */
  static render(noteId: string, text: string, w: number, h: number): HTMLCanvasElement {
    const canvas = makeCanvas();
    canvas.width = Math.max(32, Math.round(w));
    canvas.height = Math.max(32, Math.round(h));

    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('notepaper-mesher: no 2d context');

    const { padX, padTop, fontSize, lineHeight } = layoutFor(canvas.width, canvas.height);

    // Paper first, stretched over the whole quad.
    const style = NotePaper.styleFor(noteId);
    NotePaper.applyToCanvas(ctx, canvas.width, canvas.height, { paperType: style.paperType });

    // Measure against the handwriting font so wrapping matches what is drawn.
    ctx.font = `${fontSize}px "Courier New", monospace`;
    const wrapped = wrapText(ctx, text, canvas.width - padX * 2);

    // Clip to the lines that physically fit above the bottom margin.
    const usableHeight = canvas.height - padTop - Math.round(fontSize * 0.6);
    const maxLines = Math.max(1, Math.floor(usableHeight / lineHeight));
    const visible = wrapped.slice(0, maxLines);

    NotePaper.drawText(
      ctx,
      visible.join('\n'),
      padX,
      padTop + fontSize,
      style.handStyle,
      { fontSize, lineHeight },
    );

    return canvas;
  }

  /**
   * Convenience passthrough so gameplay code can preview pagination without
   * rendering (e.g. journal summaries).
   */
  static wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    return wrapText(ctx, text, maxWidth);
  }
}


