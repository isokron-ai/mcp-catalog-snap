/* global process, setInterval */
// Never answers, ignores SIGTERM and stdin EOF: only SIGKILL ends it. argv[2] is a marker for pgrep.
process.on('SIGTERM', () => {});
process.stdin.on('data', () => {});
process.stdin.on('end', () => {});
setInterval(() => {}, 1e6);
