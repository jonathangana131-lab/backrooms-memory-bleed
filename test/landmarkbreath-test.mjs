breath.stop(); // double-stop must not throw
check('double stop() is safe', true);

// ----------------------------------------------------------------------------
console.log(failures.length === 0 ? '
ALL PASS' : '\nFAILURES: ' + failures.length);
process.exit(failures.length === 0 ? 0 : 1);


