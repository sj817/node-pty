import { spawn, IPty, IWindowsPtyForkOptions } from '@qwqo/node-pty';
const options: IWindowsPtyForkOptions = { cols: 80, rows: 24, useConpty: true };
const terminal: IPty = spawn('sh', [], options);
terminal.resize(100, 40);
terminal.write('echo test\n');
terminal.onData(data => data.toUpperCase());
terminal.onExit(event => event.exitCode.toFixed());
terminal.kill();
