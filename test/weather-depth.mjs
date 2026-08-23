  // radius: normal roll is 260..680 m; x3 -> 780..2040 m
  check('storm radius 3x normal', w.front.radiusM >= 780 && w.front.radiusM <= 2040, String(w.front.radiusM));
  const tint = w.fogTint();
  check('storm tint deep violet', tint[2] > tint[0] && tint[2] > tint[1] && tint[2] > 1.0, JSON.stringify(tint));
  check('post-storm schedule pushed out', w['nextStormAt'] > 1100, String(w['nextStormAt']));
}

// ------------------------------------------------------------ 3. micro-climates
{
  const w = new MemoryWeather(555);
  const s0 = { kind: 0, intensity: 0.2 };
  w.apply(s0, w.front.cx, w.front.cz);                 // open air
  const sc = { kind: 0, intensity: 0.2 };
  w.apply(sc, w.front.cx, w.front.cz, 'corridor');     // corridor


