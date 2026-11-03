// eslint-disable-next-line @typescript-eslint/no-require-imports -- Exercise CommonJS declaration resolution.
import pty = require("@qwqo/node-pty");

const options: pty.IWindowsPtyForkOptions = {
  cols: 80,
  rows: 24,
  useConpty: true,
};
const spawn: typeof pty.spawn = pty.default.spawn;
const terminal: pty.IPty = spawn("sh", [], options);
terminal.resize(100, 40);
terminal.write("echo test\n");
terminal.onData((data) => data.toUpperCase());
terminal.onExit((event) => event.exitCode.toFixed());
terminal.kill();
