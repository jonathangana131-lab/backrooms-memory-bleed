      }
    }
  }
  return null;
});
console.log('CLEAR_CELL', JSON.stringify(clear));
if (!clear) process.exit(1);

// walk-test from the clear cell in all 4 directions
for (const dir of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
  await page.evaluate((c) => g.player.teleport(c.x, c.z, 0), clear);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => { const g = (window).__BMB__.game; return { x: g.player.body.x, z: g.player.body.z }; });
  await page.keyboard.down(dir);
  await page.waitForTimeout(1600);
  await page.keyboard.up(dir);
  const after = await page.evaluate(() => { const g = (window).__BMB__.game; return { x: +g.player.body.x.toFixed(1), z: +g.player.body.z.toFixed(1) }; });
  const d = Math.hypot(after.x - before.x, after.z - before.z);
  console.log(dir, 'moved=' + d.toFixed(1));
}
await browser.close();


