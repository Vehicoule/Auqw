function field(term: string, value: string): void {
  const list = document.getElementById('status');
  if (list === null) {
    return;
  }
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  list.append(dt, dd);
}

function describe(thrown: unknown): string {
  if (
    typeof thrown === 'object' &&
    thrown !== null &&
    'kind' in thrown &&
    'message' in thrown &&
    typeof (thrown as { message: unknown }).message === 'string'
  ) {
    const err = thrown as { kind: unknown; message: string };
    return `${String(err.kind)} — ${err.message}`;
  }
  return 'unknown error';
}

async function boot(): Promise<void> {
  const list = document.getElementById('status');
  if (list !== null) {
    list.replaceChildren();
  }
  try {
    const meta = await window.auqw.app.meta();
    field('version', meta.version);
    field('platform', meta.platform);
    field('userData', meta.userDataPath);
    console.log('auqw meta', meta.version, meta.platform);
  } catch (thrown) {
    field('app:meta', describe(thrown));
  }
  try {
    const pong = await window.auqw.utility.ping('hello from renderer');
    field('utility:ping', `${pong.reply} (${pong.echo})`);
    console.log('auqw utility:ping', pong.reply, pong.echo);
  } catch (thrown) {
    field('utility:ping', describe(thrown));
  }
  try {
    const snapshot = await window.auqw.net.snapshot();
    field('net', snapshot.online ? 'online' : 'offline');
    console.log('auqw net:snapshot', snapshot.online);
  } catch (thrown) {
    field('net:snapshot', describe(thrown));
  }
  window.auqw.net.subscribe((event) => {
    field('net transition', event.online ? 'online' : 'offline');
  });
}

void boot();
