  // Top collar hugs the rod, mid disc bulges, lower disc steps back in -
  // overlaps between bands stop hairline seams in the merged mesh.
  pushDisc(out, 0.09, -0.310, -0.370, tint);
  pushDisc(out, 0.19, -0.350, -0.415, tint);
  pushDisc(out, 0.13, -0.400, -0.450, tint);
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export const FanMeshVar = {
  * Emit the four blades for one profile as axis-aligned box specs in
 * fan-local space. With 'finish' given, each spec carries the finish
 * tint; otherwise the neutral [1,1,1] placeholder.
  blades(style: BladeStyle, finish?: FinishStyle): BoxSpec[] {
    const tint = finish ? this.tints(finish) : NEUTRAL_TINT;
    switch (style) {
      case 'flat': return flatBlades(tint);
      case 'paddle': return paddleBlades(tint);
      case 'airfoil': return airfoilBlades(tint);
      default: return fail('blade style', style);
    }
  },

  * Emit the hub treatment as axis-aligned box specs in fan-local space.
 * With 'finish' given, each spec carries the finish tint; otherwise
 * the neutral [1,1,1] placeholder.
  hub(style: HubStyle, finish?: FinishStyle): BoxSpec[] {
    const tint = finish ? this.tints(finish) : NEUTRAL_TINT;
    switch (style) {
      case 'plain': return plainHub(tint);


      case 'stacked': return stackedHub(tint);
      default: return fail('hub style', style);
    }
  },

  /** Per-finish RGB tint multipliers (office / medical / industrial). */
  tints(style: FinishStyle): Tint {
    switch (style) {
      case 'office':
      case 'medical':
      case 'industrial':
        return FINISH_TINTS[style];
      default: return fail('finish style', style);
    }
  },
};

/**
 * Feed box specs straight through the mesher's addBox pattern:
 * each spec becomes addBox(mesh, x, z, y0, y1, w, d). The caller adds the
 * fan's world offset inside its own addBox closure (mirroring how props
 * pass p.x/p.z through). Optional per-box tint hooks mirror the mesher's


