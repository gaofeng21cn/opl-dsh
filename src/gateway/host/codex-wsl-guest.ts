// Runs as the selected distribution's default user. Only fixed status codes cross the WSL boundary.
export const codexWslGuest = String.raw`
import contextlib, fcntl, hashlib, json, os, pathlib, pwd, re, secrets, shutil, signal, stat, subprocess, sys, tempfile

def fail(code):
    raise SystemExit(code)

def check(condition, code):
    if not condition: fail(code)

def run(args, data=None, timeout=30):
    try:
        return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              cwd=home, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        fail(16 if args[0] in ('/usr/bin/busctl', '/usr/bin/secret-tool') else 18)

signal.signal(signal.SIGALRM, lambda signum, frame: fail(18))
uid = os.getuid()
user = pwd.getpwuid(uid)
home = pathlib.Path(user.pw_dir)
check(uid != 0 and home.is_dir() and home.stat().st_uid == uid, 19)
dest = pathlib.Path(os.environ.get('CODEX_HOME') or home/'.codex')
check(dest.is_absolute() and dest == dest.resolve() and not str(dest).startswith('/mnt/'), 13)
base = sys.argv[1]
probe = sys.argv[2] == 'probe'
for name in list(os.environ):
    if name.startswith(('CODEX_', 'OPENAI_', 'OTEL_')) or name in ('NODE_OPTIONS','NODE_DEBUG','RUST_LOG','RUST_BACKTRACE','DEBUG'):
        del os.environ[name]
os.environ['CODEX_HOME'] = str(dest)
os.environ['HOME'] = str(home)
os.environ['LC_ALL'] = 'C'
binpath = os.pathsep.join(str(p) for p in (home/'.local/bin', home/'bin')) + ':' + os.environ['PATH']
codex = shutil.which('codex', path=binpath)
check(codex and not os.path.realpath(codex).startswith('/mnt/') and run([codex, '--version']).returncode == 0, 15)
bus = pathlib.Path('/run/user')/str(uid)/'bus'
check(bus.is_socket() and bus.stat().st_uid == uid, 21)
os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + str(bus)
os.environ['XDG_RUNTIME_DIR'] = str(bus.parent)
# WSLg sets these for CLI processes. D-Bus-activated GNOME password dialogs need the same display.
display = []
if os.environ.get('DISPLAY') == ':0' and pathlib.Path('/tmp/.X11-unix/X0').is_socket():
    display.append('DISPLAY')
if os.environ.get('WAYLAND_DISPLAY') == 'wayland-0' and (bus.parent/'wayland-0').is_socket():
    display.append('WAYLAND_DISPLAY')
if display:
    run(['/usr/bin/dbus-update-activation-environment','--systemd',*display])
os.umask(0o077)
dest.mkdir(mode=0o700, parents=True, exist_ok=True)
check(dest.is_dir() and dest.stat().st_uid == uid, 13)
lock = os.open(dest, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: fail(17)
def no_auth_file():
    return not os.path.lexists(dest/'auth.json')
check(no_auth_file(), 12)

def keyring_probe():
    marker = secrets.token_hex(24).encode()
    attr = ['opl-setup-probe', secrets.token_hex(20)]
    tool = '/usr/bin/secret-tool'
    try:
        check(run([tool,'store','--label=OPL Codex credential check', *attr], marker, 60).returncode == 0, 16)
        r = run([tool,'lookup',*attr])
        check(r.returncode == 0 and r.stdout.rstrip(b'\n') == marker, 16)
    finally:
        check(run([tool,'clear',*attr]).returncode == 0, 16)
    # An empty GNOME keyring password selects its plaintext file format. Check only the file headers.
    keyrings = pathlib.Path(os.environ.get('XDG_DATA_HOME') or home/'.local/share')/'keyrings'
    alias = run(['/usr/bin/busctl','--user','call','org.freedesktop.secrets','/org/freedesktop/secrets',
                 'org.freedesktop.Secret.Service','ReadAlias','s','default'])
    found = re.fullmatch(rb'o "/org/freedesktop/secrets/collection/([a-zA-Z0-9_]+)"', alias.stdout.strip())
    check(alias.returncode == 0 and found, 22)
    name = os.fsdecode(re.sub(rb'_([0-9a-fA-F]{2})',lambda m: bytes.fromhex(m[1].decode()), found[1]))
    check(name not in ('session','.','..') and '/' not in name and chr(0) not in name, 22)
    try:
        with (keyrings/(name+'.keyring')).open('rb') as wallet:
            check(wallet.read(16).hex() == '476e6f6d654b657972696e670a0d000a', 22)
    except OSError: fail(22)
keyring_probe()
def login(args, key=None):
    return run([codex,'-c','cli_auth_credentials_store="keyring"','login',*args], key)
def state():
    r = login(['status'])
    if r.returncode == 0: return True
    check(r.returncode == 1 and b'Not logged in' in r.stderr+r.stdout, 16)
    return False
@contextlib.contextmanager
def server(force_keyring=False):
    args = [codex] + (['-c','cli_auth_credentials_store="keyring"'] if force_keyring else []) + ['app-server']
    p = subprocess.Popen(args,
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=home)
    seq = 0
    def write(msg):
        p.stdin.write((json.dumps(msg)+'\n').encode()); p.stdin.flush()
    def request(method, params):
        nonlocal seq
        seq += 1
        write({'method':method,'id':seq,'params':params})
        signal.alarm(25)
        for line in p.stdout:
            reply = json.loads(line)
            if reply.get('id') == seq:
                signal.alarm(0)
                check('result' in reply, 18)
                return reply['result']
        fail(18)
    try:
        request('initialize', {'clientInfo':{'name':'opl_gateway_setup','version':'1'}})
        write({'method':'initialized'})
        yield request
    finally:
        signal.alarm(0)
        p.kill(); p.wait(timeout=5)
def inspect():
    with server() as rpc: return rpc('config/read', {'includeLayers':True})
def user_version(snapshot):
    return next((l['version'] for l in snapshot.get('layers') or [] if l.get('name',{}).get('type') == 'user'), None)
def configured(snapshot):
    cfg = snapshot['config']
    provider = (cfg.get('model_providers') or {}).get('opl_gateway') or {}
    return (cfg.get('cli_auth_credentials_store') == 'keyring' and cfg.get('model_provider') == 'opl_gateway' and provider.get('base_url') == base and
            provider.get('wire_api') == 'responses' and provider.get('requires_openai_auth') is True)
path = dest/'config.toml'
def read_config():
    if not os.path.lexists(path): return None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as f:
        st = os.fstat(f.fileno())
        check(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == uid, 13)
        return f.read()
before = read_config()
had_login = state()
snapshot = inspect()
check(not had_login or configured(snapshot), 12)
identity = hashlib.sha256(json.dumps([uid, str(home), str(dest), os.path.realpath(codex),
                          user_version(snapshot), had_login]).encode()).hexdigest()
if probe:
    print(identity)
    sys.exit(0)
check(secrets.compare_digest(sys.argv[3], identity), 17)
key = sys.stdin.buffer.readline(16385).rstrip(b'\n')
check(0 < len(key) <= 16384 and not any(c <= 32 or c > 126 for c in key), 18)
def matches():
    with server(True) as rpc:
        result = rpc('getAuthStatus',{'includeToken':True,'refreshToken':False})
        return secrets.compare_digest((result.get('authToken') or '').encode(), key)
if had_login:
    check(matches(), 12)
    sys.exit(0)
values = {
    'model_provider':'opl_gateway', 'cli_auth_credentials_store':'keyring', 'model':'gpt-6.2-sol',
    'model_providers.opl_gateway':{'name':'OPL Gateway','base_url':base,
                                  'wire_api':'responses','requires_openai_auth':True}}
written = None
attempted_login = False
try:
    check(no_auth_file() and read_config() == before, 17)
    with server() as rpc:
        args = {'edits':[{'keyPath':k,'value':v,'mergeStrategy':'replace'} for k,v in values.items()]}
        if user_version(snapshot): args['expectedVersion'] = user_version(snapshot)
        result = rpc('config/batchWrite', args)
    candidate = read_config()
    after = inspect()
    check(user_version(after) == result['version'], 17)
    written = candidate
    check(result.get('status') == 'ok' and configured(after)
          and after['config'].get('model') == values['model'] and no_auth_file() and not state(), 18)
    attempted_login = True
    check(login(['--with-api-key'],key+b'\n').returncode == 0, 16)
    check(state() and matches() and no_auth_file(), 18)
except BaseException:
    auth_uncertain = False
    if attempted_login:
        try:
            if matches():
                logged_out = run([codex,'-c','cli_auth_credentials_store="keyring"','logout'])
                auth_uncertain = logged_out.returncode != 0 or state()
            else:
                auth_uncertain = state()
        except (Exception, SystemExit):
            auth_uncertain = True
    if written is not None:
        check(read_config() == written, 17)
        if before is None: path.unlink()
        else:
            with tempfile.NamedTemporaryFile(dir=dest, delete=False) as f: f.write(before)
            os.replace(f.name, path)
    check(not auth_uncertain, 23)
    raise
`
