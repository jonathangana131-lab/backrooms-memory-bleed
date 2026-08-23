ok(src.includes('new Compass(this.ui.hud)'), 'B-3b Compass built into HUD host');
ok(src.includes('this.compass.update(') && src.includes('nx2, nz2, isFinite(nb)'), 'B-3b compass aims at nearest unfound beacon when active');
ok(src.includes('compass.hide()'), 'B-3b compass hides when inactive');
ok(src.includes('new WeatherUI(this.ui.hud)'), 'B-3c WeatherUI built into HUD host');
ok(src.includes('weatherUi.update(this.weather.nextFront())'), 'B-3c update(weather.nextFront()) per frame');
ok(src.includes('weatherUi.setPhase(this.weatherPhase)') && src.includes('this.weatherPhase = this.director.phase'), 'B-3c setPhase(director.phase)');
ok(src.includes('weatherUi?.reset()'), 'B-3c reset per run');

// guard convention: every new construction try/catch-wrapped with [bmb] warns
const constructions = [
  'new PostFX()', 'new FaunaWiring(this.scene, this.seed)', 'new GazeWiring()',
  'new Minimap(this.ui.hud)', 'new Compass(this.ui.hud)', 'new WeatherUI(this.ui.hud)',
].concat(audioModules.map(([n]) => 'new ' + n + '(ctx, dest)'));
for (const c of constructions) {
  const idx = src.indexOf(c);


