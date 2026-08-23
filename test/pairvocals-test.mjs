    gainsAll.some(function (n) {
      return n.gain.targets.some(function (x) { return x.v <= 0.0001; });
    }));
  step(ctx, pv, 3, duo);
  check('stopped instance ignores update()', pv.debugState().length === 0);
}

console.log(failures.length === 0
  ? '
ALL PASS'
  : '
' + failures.length + ' FAILURE(S): ' + failures.join(', '));
process.exitCode = failures.length === 0 ? 0 : 1;


