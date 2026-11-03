import pty, { spawn, IPty, IWindowsPtyForkOptions } from "@qwqo/node-pty";
const compatibleSpawn: typeof spawn = pty.spawn;
const options: IWindowsPtyForkOptions = { cols: 80, rows: 24, useConpty: true };
const terminal: IPty = compatibleSpawn("sh", [], options);
terminal.resize(100, 40);
terminal.write("echo test\n");
terminal.onData((data) => data.toUpperCase());
terminal.onExit((event) => event.exitCode.toFixed());
terminal.kill();
