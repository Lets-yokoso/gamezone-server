"""
GameZone PC Client - Full Featured with Reliable Sleep/Shutdown + Fixed Timer HUD
Changes:
- Font size 20, padx/pady 0
- Lock screen refresh 2000ms
- Timer red at 1min, fully red at 30s
- Mute on lock, unmute on unlock
- Add time to stopwatch (transfer time feature)
- Prepaid/unpaid payment noting
- Lock image auto-loaded from logs folder
- Bug fix: waits for network on startup
- FIXED: Timer HUD stays above fullscreen games (enhanced SetWindowPos flags)
- Bug fix: HUD stays above fullscreen games (SetWindowPos every 100ms)
- Config: group/pc/password updated
- FIXED: Sleep/Shutdown using reliable Windows system commands (subprocess)
- FIXED: Heartbeat to keep online status synced
- FIXED: Folder name changed from 'shortcuts' to 'Launchers'
- FIXED: App refresh handler added for web dashboard sync
- FIXED: Crash on launch - added error handling for config loading
- FIXED: Added dependency checks with clear install instructions
"""
import json, os, time, threading, queue, ctypes, glob, sys, traceback, re, csv
import urllib.request, ssl as _ssl_mod
import ctypes.wintypes as wt
import subprocess

# Fix #10: Move all imports to top level

# Disable SSL verification globally for outdated certificate stores
try:
    import requests
    requests.packages.urllib3.disable_warnings()
    _old_https = _ssl_mod.create_default_https_context
    _ssl_mod.create_default_https_context = _ssl_mod._create_unverified_context
except Exception:
    pass

import tkinter as tk
from tkinter import font as tkfont
import socketio
import psutil

CONFIG_FILE   = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
LAUNCHERS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'Launchers')
LOGS_DIR      = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
os.makedirs(LAUNCHERS_DIR, exist_ok=True)
os.makedirs(LOGS_DIR, exist_ok=True)

def load_config():
    with open(CONFIG_FILE, 'r') as f:
        return json.load(f)

def save_config(config):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)

ui_queue   = queue.Queue()
_is_locked = threading.Event()

# ─── Process Filtering Helpers ────────────────────────────────────────────────
def _is_python_process(name: str) -> bool:
    """Check if a process name is any Python interpreter variant."""
    name_lower = name.lower()
    base_name = name_lower[:-4] if name_lower.endswith('.exe') else name_lower
    if base_name in ('py', 'pyw'):
        return True
    if base_name.startswith('python'):
        return True
    if 'python' in base_name:
        return True
    return False

# ─── Audio Mute/Unmute ────────────────────────────────────────────────────────
NIRCMD_URL = "https://www.nirsoft.net/utils/nircmd.zip"
NIRCMD_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nircmd.exe")
_nircmd_attempted = False

def _ensure_nircmd():
    """Download nircmd.exe if not present — tiny 50KB tool."""
    global _nircmd_attempted
    if os.path.exists(NIRCMD_PATH):
        return True
    if _nircmd_attempted:
        return False
    _nircmd_attempted = True
    try:
        import zipfile, io, ssl
        print("[>>] Downloading nircmd for silent mute...")
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        data = urllib.request.urlopen(NIRCMD_URL.strip(), timeout=10, context=ctx).read()
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for name in z.namelist():
                if name.lower() == "nircmd.exe":
                    with open(NIRCMD_PATH, "wb") as f:
                        f.write(z.read(name))
                    print("[OK] nircmd downloaded")
                    return True
    except Exception as e:
        print(f"[-] nircmd download failed: {e}")
    return False

def set_mute(mute):
    """Silent mute via nircmd — zero OSD, zero popup."""
    try:
        if _ensure_nircmd():
            val = "1" if mute else "0"
            subprocess.Popen(
                [NIRCMD_PATH, "mutesysvolume", val],
                creationflags=0x08000000,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            print(f"[+] Audio mute={mute} (nircmd)")
        else:
            print("[-] nircmd not available, mute skipped")
    except Exception as e:
        print(f"[-] Mute error: {e}")

# Download nircmd on startup
threading.Thread(target=_ensure_nircmd, daemon=True).start()

# ─── Session Logger ───────────────────────────────────────────────────────────
SESSION_LOG = os.path.join(LOGS_DIR, 'sessions.txt')
_last_log   = {}

def flush_old_entries():
    if not os.path.exists(SESSION_LOG):
        return
    cutoff = time.time() - 86400
    try:
        with open(SESSION_LOG, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        kept = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                ts = float(line.split('|')[0].strip())
                if ts >= cutoff:
                    kept.append(line)
            except Exception:
                pass  # Fix #11: Drop malformed lines instead of keeping them forever
        with open(SESSION_LOG, 'w', encoding='utf-8') as f:
            f.write('\n'.join(kept) + ('\n' if kept else ''))
    except Exception as e:
        print(f'[-] Log flush error: {e}')

def log_session_event(event, detail=''):
    now = time.time()
    if _last_log.get(event, 0) > now - 5:
        return
    _last_log[event] = now
    flush_old_entries()
    ts_unix  = int(now)
    ts_human = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now))
    try:
        pc_name = load_config().get('pc_name', '')
    except Exception:
        pc_name = ''
    line = f'{ts_unix} | {ts_human} | {pc_name} | {event}'
    if detail:
        line += f' | {detail}'
    try:
        with open(SESSION_LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
        print(f'[LOG] {line}')
    except Exception as e:
        print(f'[-] Log write error: {e}')

flush_old_entries()

# ─── Find lock image from logs folder ────────────────────────────────────────
def find_lock_image():
    # Fix #7: Sort matches for deterministic selection (first alphabetically)
    for ext in ('*.png', '*.jpg', '*.jpeg', '*.gif', '*.bmp'):
        matches = sorted(glob.glob(os.path.join(LOGS_DIR, ext)))
        if matches:
            return matches[0]
    return ''

# ─── Lock Screen ─────────────────────────────────────────────────────────────
class LockScreen:
    def __init__(self, root, message="Time's up!", image_path=None):
        self.root       = root
        self.message    = message
        self.image_path = image_path if image_path else find_lock_image()
        self.alive      = True
        self.wins       = []
        self._spawn()
        self._refresh()

    def _spawn(self):
        if not self.alive:
            return
        try:
            win = tk.Toplevel(self.root)
            win.attributes('-fullscreen', True)
            win.attributes('-topmost',    True)
            win.configure(bg='black')
            win.bind('<Key>',    lambda e: 'break')
            win.bind('<Button>', lambda e: 'break')
            win.protocol("WM_DELETE_WINDOW", lambda: None)
            self._build(win)
            win.focus_force()
            win.lift()
            try:
                hwnd = win.winfo_id()
                ctypes.windll.user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x43)
            except Exception:
                pass
            self.wins.append(win)
        except Exception as e:
            print(f'[-] Lock spawn error: {e}')

    def _refresh(self):
        if not self.alive:
            return
        self._spawn()
        while len(self.wins) > 2:
            old = self.wins.pop(0)
            try: old.destroy()
            except: pass
        self.root.after(2000, self._refresh)

    def _build(self, win):
        if self.image_path and os.path.exists(self.image_path):
            try:
                img = tk.PhotoImage(file=self.image_path)
                lbl = tk.Label(win, image=img, bg='black')
                lbl.image = img
                lbl.place(relx=0.5, rely=0.5, anchor='center')
                return
            except Exception:
                pass
        frame = tk.Frame(win, bg='black')
        frame.place(relx=0.5, rely=0.5, anchor='center')
        tk.Label(frame, text='⏰',
                 font=tkfont.Font(size=72), bg='black', fg='#ff4444').pack(pady=10)
        tk.Label(frame, text='SESSION ENDED',
                 font=tkfont.Font(family='Helvetica', size=36, weight='bold'),
                 bg='black', fg='white').pack(pady=10)
        tk.Label(frame, text=self.message,
                 font=tkfont.Font(family='Helvetica', size=18),
                 bg='black', fg='#aaaaaa').pack(pady=10)

    def destroy(self):
        self.alive = False
        for win in self.wins:
            try: win.destroy()
            except: pass
        self.wins.clear()

# ─── Timer HUD ───────────────────────────────────────────────────────────────
TRANSPARENT_KEY = '#010101'

class TimerHUD:
    def __init__(self, root, countdown=True):
        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)
        self.win.attributes('-topmost', True)
        self.win.attributes('-alpha', 1.0)
        self.win.configure(bg=TRANSPARENT_KEY)
        try:
            self.win.wm_attributes('-transparentcolor', TRANSPARENT_KEY)
        except Exception:
            pass
        sw = self.win.winfo_screenwidth()
        self.win.geometry(f'180x42+{sw-188}+20')
        self.countdown  = countdown
        self.time_var   = tk.StringVar(value='--:--')
        self.lbl = tk.Label(
            self.win, textvariable=self.time_var,
            font=tkfont.Font(family='Helvetica', size=20, weight='bold'),
            bg=TRANSPARENT_KEY, fg='#00ff88',
            padx=0, pady=0)
        self.lbl.pack(fill='both', expand=True)
        self.alive      = True
        self._max_secs  = 0
        self._enforce_top()

    def _enforce_top(self):
        """Every 50ms force window above fullscreen games with enhanced flags."""
        try:
            if not self.alive:
                return
            if not self.win.winfo_exists():
                self.alive = False
                return
            hwnd = self.win.winfo_id()
            flags = 0x0002 | 0x0001 | 0x0040 | 0x0010
            ctypes.windll.user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, flags)
            self.win.attributes('-topmost', True)
            self.win.after(50, self._enforce_top)
        except tk.TclError:
            self.alive = False
        except Exception as e:
            print(f'[-] Enforce top error: {e}')
            self.win.after(100, self._enforce_top)

    @staticmethod
    def _lerp_color(t):
        if t <= 0.5:
            f = t / 0.5
            r = int(0x00 + f * 0xff)
            g = int(0xff + f * (0xdd - 0xff))
            b = int(0x88 + f * (0x00 - 0x88))
        else:
            f = (t - 0.5) / 0.5
            r = 0xff
            g = int(0xdd + f * (0x00 - 0xdd))
            b = int(0x00 + f * 0x55)
        return f'#{r:02x}{g:02x}{b:02x}'

    def update(self, secs):
        if not self.alive:
            return
        secs = max(0, int(secs))
        h, rem = divmod(secs, 3600)
        m, s   = divmod(rem, 60)
        self.time_var.set(f'{h}:{m:02d}:{s:02d}' if h else f'{m:02d}:{s:02d}')
        if self.countdown:
            if secs >= 60:
                c = '#00ff88'
            elif secs <= 30:
                c = '#ff3355'
            else:
                t = 1.0 - ((secs - 30) / (60 - 30))
                c = self._lerp_color(t)
        else:
            c = '#00aaff'
        self.lbl.config(fg=c)

    def destroy(self):
        self.alive = False
        try: self.win.destroy()
        except: pass

# ─── Shortcuts/Apps from Launchers folder ─────────────────────────────────────
def get_shortcuts():
    apps = []
    if not os.path.exists(LAUNCHERS_DIR):
        return apps
    # Fix #5: Only .exe and .lnk files — remove .url (internet shortcuts)
    for f in os.listdir(LAUNCHERS_DIR):
        if f.lower().endswith(('.exe', '.lnk')):
            apps.append({'name': os.path.splitext(f)[0],
                         'path': os.path.splitext(f)[0]})
    apps.sort(key=lambda x: x['name'].lower())
    print(f'[+] Found {len(apps)} apps in Launchers folder')
    return apps

# ─── Socket Worker ────────────────────────────────────────────────────────────
class SocketWorker:
    def __init__(self, config):
        self.config = config
        self.sio    = socketio.Client(
            reconnection=True, reconnection_attempts=0, reconnection_delay=5)
        self._setup()

    def _setup(self):
        @self.sio.on('connect')
        def _():
            print('[+] Connected, authenticating...')
            self.sio.emit('pc:auth', {
                'pc_name':  self.config['pc_name'],
                'group_id': self.config['group_id'],
                'password': self.config['pc_password'],
            }, callback=self._on_auth)

        @self.sio.on('disconnect')
        def _(): print('[-] Disconnected. Reconnecting...')

        @self.sio.on('session:start')
        def _(data):
            rem  = data.get('remaining_seconds', data['session_end'] - time.time())
            mins = int(rem // 60)
            print(f'[+] Session start, {rem:.0f}s remaining')
            log_session_event('SESSION STARTED', f'{mins} min')
            ui_queue.put(('unlock',))
            ui_queue.put(('countdown', rem))

        @self.sio.on('session:add-time')
        def _(data):
            rem   = data.get('remaining_seconds', data['session_end'] - time.time())
            added = data.get('added_minutes', '?')
            print(f'[+] Time updated, {rem:.0f}s remaining')
            log_session_event('TIME CHANGED', f'{added:+} min | {int(rem//60)} min remaining')
            ui_queue.put(('update_remaining', rem))

        @self.sio.on('session:end')
        def _(_d):
            print('[+] Session ended')
            log_session_event('SESSION ENDED', 'ended by admin')
            ui_queue.put(('lock_end',))

        @self.sio.on('session:stopwatch')
        def _(data):
            print('[+] Stopwatch started')
            log_session_event('FREE TIMER STARTED')
            ui_queue.put(('unlock',))
            ui_queue.put(('stopwatch', data['started_at']))

        @self.sio.on('session:stopwatch-end')
        def _(_d):
            print('[+] Stopwatch stopped')
            log_session_event('FREE TIMER STOPPED')
            ui_queue.put(('lock_end',))

        @self.sio.on('command:lock')
        def _(_d):
            print('[+] Manual lock')
            log_session_event('MANUAL LOCK')
            ui_queue.put(('lock',))

        @self.sio.on('command:unlock')
        def _(_d):
            print('[+] Unlock')
            log_session_event('MANUAL UNLOCK')
            ui_queue.put(('unlock',))

        @self.sio.on('command:sleep')
        def _(data):
            print('[+] Sleep command received')
            log_session_event('SLEEP COMMAND', 'received from admin')
            ui_queue.put(('sleep',))

        @self.sio.on('command:shutdown')
        def _(data):
            print('[+] Shutdown command received')
            log_session_event('SHUTDOWN COMMAND', 'received from admin')
            ui_queue.put(('shutdown',))

        @self.sio.on('command:get-processes')
        def _(_d):
            print('[+] Process list requested')
            threading.Thread(target=self._send_processes, daemon=True).start()

        @self.sio.on('command:kill-process')
        def _(data):
            pid  = data.get('pid')
            name = data.get('name','')
            print(f'[+] Kill process: {name} (pid={pid})')
            ui_queue.put(('kill_process', pid, name))

        @self.sio.on('command:launch')
        def _(data):
            name = data.get('app_path', '').strip()
            print(f'[+] Launch: {name}')
            ui_queue.put(('launch', name))

        @self.sio.on('command:refresh-apps')
        def _(_data):
            print('[+] App refresh requested — re-scanning Launchers folder')
            apps = get_shortcuts()
            self.sio.emit('pc:apps', {'apps': apps})
            log_session_event('APPS REFRESHED', f'{len(apps)} apps found')

    def _on_auth(self, resp):
        if resp.get('success'):
            print(f'[+] Authenticated as: {self.config["pc_name"]}')
            rem = resp.get('remaining_seconds', 0)
            sw  = resp.get('stopwatch_start', 0)
            apps = get_shortcuts()
            self.sio.emit('pc:apps', {'apps': apps})
            if rem > 0:
                ui_queue.put(('countdown', rem))
            elif sw > 0:
                ui_queue.put(('stopwatch', sw))
            else:
                print('[*] No active session — locking on startup')
                ui_queue.put(('lock_end',))
            self._start_heartbeat()
        else:
            print(f'[-] Auth failed: {resp.get("error")}')
            print('    Check Group ID, PC Name and Password in config.json')
            # Fix #9: Reset stale session state on auth failure
            ui_queue.put(('lock_end',))

    def _start_heartbeat(self):
        """Send periodic heartbeat to keep connection status fresh."""
        # Fix #1: Use while loop instead of recursive calls to prevent stack overflow
        def send():
            while True:
                if not self.sio.connected:
                    time.sleep(5)
                    continue
                try:
                    self.sio.emit('pc:heartbeat', {
                        'pc_name': self.config['pc_name'],
                        'group_id': self.config['group_id'],
                        'timestamp': time.time()
                    })
                except Exception as e:
                    print(f'[-] Heartbeat error: {e}')
                time.sleep(30)

        threading.Thread(target=send, daemon=True).start()
        print('[+] Heartbeat started (every 30s)')

    def _send_processes(self):
        """Return only processes with visible taskbar windows."""
        try:
            visible_pids = set()
            user32 = ctypes.windll.user32
            WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

            def enum_cb(hwnd, _):
                if not user32.IsWindowVisible(hwnd):
                    return True
                if user32.GetWindow(hwnd, 4):
                    return True
                length = user32.GetWindowTextLengthW(hwnd)
                if length == 0:
                    return True
                cloaked = ctypes.c_int(0)
                try:
                    ctypes.windll.dwmapi.DwmGetWindowAttribute(
                        hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
                    if cloaked.value:
                        return True
                except Exception:
                    pass
                pid = wt.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                visible_pids.add(pid.value)
                return True

            user32.EnumWindows(WNDENUMPROC(enum_cb), 0)
            print(f'[DEBUG] visible window PIDs: {len(visible_pids)}')

            if not visible_pids:
                self.sio.emit('pc:processes', {'processes': []})
                return

            out = subprocess.check_output(
                ['tasklist', '/FO', 'CSV', '/NH'],
                stderr=subprocess.DEVNULL
            ).decode('utf-8', errors='ignore')

            result = []
            for line in out.strip().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    parts = list(csv.reader([line]))[0]
                except Exception:
                    continue
                if len(parts) < 5:
                    continue
                try:
                    pid = int(parts[1].strip())
                except Exception:
                    continue
                if pid not in visible_pids:
                    continue
                name = parts[0].strip()
                if _is_python_process(name) or name.lower() == 'gamezone_client.exe':
                    continue
                digits = re.sub(r'[^0-9]', '', parts[4])
                mem_kb = int(digits) if digits else 0
                mem_mb = round(mem_kb / 1024, 1)
                display = name[:-4] if name.lower().endswith('.exe') else name
                result.append({'pid': pid, 'name': name, 'display': display, 'mem': mem_mb})

            result.sort(key=lambda x: x['display'].lower())
            print(f'[+] Sending {len(result)} taskbar processes')
            self.sio.emit('pc:processes', {'processes': result})
        except Exception as e:
            print(f'[-] Process list error: {e}')
            self.sio.emit('pc:processes', {'processes': []})

    def run(self):
        print('[*] Waiting for network...')
        time.sleep(8)
        url = self.config['server_url'].rstrip('/')
        print(f'[*] Connecting to {url}...')
        while True:
            try:
                import ssl as _ssl
                self.sio.connect(url, transports=['websocket'],
                                 wait_timeout=10)
                self.sio.wait()
            except Exception as e:
                print(f'[-] Error: {e}. Retrying in 5s...')
                time.sleep(5)

# ─── Main App ────────────────────────────────────────────────────────────────
class GameZoneApp:
    def __init__(self, config):
        self.config          = config
        self.root            = tk.Tk()
        self.root.withdraw()
        self.lock_screen     = None
        self.hud             = None
        self.is_locked       = False
        self.session_end     = 0
        self.stopwatch_start = 0
        self.hud_mode        = None
        self._gen            = 0

    def process_queue(self):
        try:
            while True:
                cmd = ui_queue.get_nowait()
                op  = cmd[0]

                if op == 'lock':
                    self._lock(clear_session=False)

                elif op == 'lock_end':
                    self._lock(clear_session=True)

                elif op == 'unlock':
                    was_locked = self.is_locked
                    self._unlock()
                    if was_locked:
                        if self.session_end > time.time() and self.session_end > 0:
                            self.hud_mode = 'countdown'
                            self._start_hud()
                        elif self.stopwatch_start > 0:
                            self.hud_mode = 'stopwatch'
                            self._start_hud()

                elif op == 'countdown':
                    self.session_end     = time.time() + cmd[1]
                    self.stopwatch_start = 0
                    self.hud_mode        = 'countdown'
                    self._unlock()
                    self._start_hud()

                elif op == 'stopwatch':
                    self.stopwatch_start = cmd[1]
                    self.session_end     = 0
                    self.hud_mode        = 'stopwatch'
                    self._unlock()
                    self._start_hud()

                elif op == 'update_remaining':
                    self.session_end = time.time() + cmd[1]
                    if self.is_locked:
                        self.hud_mode = 'countdown'
                        self._unlock()
                        self._start_hud()
                    elif not self.hud or not self.hud.alive:
                        self.hud_mode = 'countdown'
                        self._start_hud()

                elif op == 'stop_hud':
                    self._kill_hud()

                elif op == 'kill':
                    self._kill_tasks()

                elif op == 'kill_process':
                    self._kill_process(cmd[1], cmd[2])

                elif op == 'launch':
                    self._launch(cmd[1])

                elif op == 'sleep':
                    self._sleep()

                elif op == 'shutdown':
                    self._shutdown()

        except queue.Empty:
            pass
        self.root.after(100, self.process_queue)

    def _kill_hud(self):
        self._gen += 1
        if self.hud:
            self.hud.destroy()
            self.hud = None

    def _start_hud(self):
        self._kill_hud()
        self.hud   = TimerHUD(self.root, countdown=(self.hud_mode == 'countdown'))
        my_gen     = self._gen
        self._tick(my_gen)

    def _tick(self, gen):
        if gen != self._gen:   return
        if not self.hud:       return
        if not self.hud.alive: return
        if self.is_locked:     return

        if self.hud_mode == 'countdown':
            left = self.session_end - time.time()
            if left <= 0:
                print('[*] Timer expired — locking')
                log_session_event('SESSION EXPIRED', 'timer ran out')
                self._kill_hud()
                self.session_end = 0
                self.root.after(50, lambda: self._lock(clear_session=True))
                return
            self.hud.update(int(left))
        else:
            self.hud.update(int(time.time() - self.stopwatch_start))

        self.root.after(1000, lambda: self._tick(gen))

    def _lock(self, clear_session=True):
        print('[*] Locking screen')
        self.is_locked = True
        _is_locked.set()
        self._kill_hud()
        if clear_session:
            self.session_end     = 0
            self.stopwatch_start = 0
        set_mute(True)
        if not self.lock_screen:
            self.lock_screen = LockScreen(
                self.root,
                message    = self.config.get('lock_message',
                             "Please see staff to add more time."),
                image_path = self.config.get('lock_image_path', ''))

    def _unlock(self):
        print('[*] Unlocking screen')
        self.is_locked = False
        _is_locked.clear()
        set_mute(False)
        if self.lock_screen:
            self.lock_screen.destroy()
            self.lock_screen = None

    def _sleep(self):
        """Put PC to sleep using rundll32.exe (most reliable method)."""
        try:
            subprocess.Popen(
                ['rundll32.exe', 'powrprof.dll,SetSuspendState', '0,1,0'],
                creationflags=0x08000000,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            print('[+] Sleep command executed via rundll32.exe')
            log_session_event('SLEEP EXECUTED', 'system sleep initiated via rundll32')
        except Exception as e:
            print(f'[-] Sleep error: {e}')
            log_session_event('SLEEP ERROR', str(e))

    def _shutdown(self):
        """Shutdown PC using shutdown.exe command (most reliable)."""
        try:
            subprocess.Popen(
                ['shutdown', '/s', '/f', '/t', '0'],
                creationflags=0x08000000,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            print('[+] Shutdown command executed via shutdown.exe')
            log_session_event('SHUTDOWN EXECUTED', 'system shutdown initiated via shutdown.exe')
        except Exception as e:
            print(f'[-] Shutdown error: {e}')
            log_session_event('SHUTDOWN ERROR', str(e))

    def _kill_tasks(self):
        """Kill all non-system user processes — terminates running games/apps."""
        try:
            keep = {'explorer.exe','taskhostw.exe',
                    'sihost.exe','csrss.exe','wininit.exe','winlogon.exe',
                    'lsass.exe','services.exe','svchost.exe','dwm.exe',
                    'ctfmon.exe','fontdrvhost.exe','spoolsv.exe','conhost.exe'}
            my_pid = os.getpid()
            killed = 0
            for proc in psutil.process_iter(['pid','name']):
                try:
                    name = proc.info['name'].lower()
                    if proc.info['pid'] == my_pid:
                        continue
                    if name in keep:
                        continue
                    if _is_python_process(name):
                        continue
                    proc.kill()
                    killed += 1
                except Exception:
                    pass
            print(f'[+] Killed {killed} processes')
        except Exception as e:
            try:
                subprocess.Popen(
                    ['taskkill', '/F', '/FI', 'STATUS eq RUNNING', '/FI', 'MEMUSAGE gt 10000'],
                    creationflags=0x08000000,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                print('[+] Kill signal sent via taskkill')
            except Exception as e2:
                print(f'[-] Kill error: {e2}')

    def _kill_process(self, pid, name):
        """Kill a specific process by PID."""
        if _is_python_process(name):
            print(f'[-] Skipping Python process: {name} (pid={pid})')
            return
        try:
            try:
                p = psutil.Process(pid)
                p.kill()
                print(f'[+] Killed process {name} (pid={pid})')
            except psutil.NoSuchProcess:
                print(f'[-] Process {pid} not found')
            except Exception as e:
                print(f'[-] Kill error: {e}')
        except Exception:
            try:
                subprocess.Popen(['taskkill', '/F', '/PID', str(pid)],
                               creationflags=0x08000000,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception as e:
                print(f'[-] Kill error: {e}')

    def _launch(self, name):
        if not name:
            return
        local_path = None
        # Fix #3: Handle full paths from server (e.g. "C:\Games\game.exe")
        if os.path.isabs(name) and os.path.exists(name):
            local_path = name
        else:
            # Fix #2: Wrap os.listdir in try/except for crash safety
            try:
                if os.path.exists(LAUNCHERS_DIR):
                    for f in os.listdir(LAUNCHERS_DIR):
                        if os.path.splitext(f)[0] == name or f == name:
                            local_path = os.path.join(LAUNCHERS_DIR, f)
                            break
            except Exception as e:
                print(f'[-] Error scanning Launchers folder: {e}')
        if not local_path:
            print(f'[-] App not found: {name}')
            return
        try:
            ctypes.windll.shell32.ShellExecuteW(
                None, "open", local_path, None, None, 1)
            print(f'[+] Launched: {local_path}')
        except Exception:
            try:
                os.startfile(local_path)
            except Exception as e:
                print(f'[-] Launch error: {e}')

    def run(self):
        worker = SocketWorker(self.config)
        threading.Thread(target=worker.run, daemon=True).start()
        self.root.after(100, self.process_queue)
        self.root.mainloop()

# ─── Setup UI ─────────────────────────────────────────────────────────────────
class SetupUI:
    UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

    def __init__(self):
        self.root = tk.Tk()
        self.root.title('GameZone PC Setup')
        self.root.geometry('460x370')
        self.root.configure(bg='#1a1a2e')
        self.root.resizable(False, False)
        self._build()

    def _build(self):
        tf = tkfont.Font(family='Helvetica', size=18, weight='bold')
        lf = tkfont.Font(family='Helvetica', size=11)
        tk.Label(self.root, text='GameZone PC Setup', font=tf,
                 bg='#1a1a2e', fg='#00ff88').pack(pady=20)
        frame = tk.Frame(self.root, bg='#1a1a2e')
        frame.pack(padx=30, fill='x')
        fields = [
            ('Server URL:',  'server_url',  'https://your-server.up.railway.app  ', False),
            ('Group ID:',    'group_id',    'Paste from phone app Settings',       False),
            ('PC Name:',     'pc_name',     'PC-1',                                False),
            ('PC Password:', 'pc_password', '',                                    True),
        ]
        self.entries = {}
        for label, key, placeholder, secret in fields:
            row = tk.Frame(frame, bg='#1a1a2e')
            row.pack(fill='x', pady=5)
            tk.Label(row, text=label, font=lf, bg='#1a1a2e', fg='white',
                     width=14, anchor='w').pack(side='left')
            e = tk.Entry(row, font=lf, bg='#16213e', fg='white',
                         insertbackground='white', show='*' if secret else '')
            e.insert(0, placeholder)
            e.pack(side='left', fill='x', expand=True, ipady=5)
            self.entries[key] = e
        tk.Button(self.root, text='Save & Connect', font=lf,
                  bg='#00ff88', fg='black', command=self._save,
                  pady=10, bd=0, cursor='hand2').pack(pady=20, padx=30, fill='x')
        self.status = tk.Label(self.root, text='', font=lf,
                               bg='#1a1a2e', fg='#ff4444')
        self.status.pack()

    def _save(self):
        config = {k: e.get().strip() for k, e in self.entries.items()}
        if not all(config.values()):
            self.status.config(text='Please fill all fields!')
            return
        # Fix #8: Validate group_id is a valid UUID
        if not self.UUID_RE.match(config['group_id']):
            self.status.config(text='Group ID must be a valid UUID')
            return
        config['lock_image_path'] = ''
        config['lock_message']    = "Time's up! Please see staff to add more time."
        save_config(config)
        self.root.destroy()

    def run(self):
        self.root.mainloop()
        return load_config()

if __name__ == '__main__':
    missing_deps = []
    try:
        import socketio
    except ImportError:
        missing_deps.append('python-socketio')
    try:
        import psutil
    except ImportError:
        missing_deps.append('psutil')

    if missing_deps:
        print(f'\nMissing required packages: {", ".join(missing_deps)}')
        print('\nInstall them with:')
        print('  pip install python-socketio[client] psutil')
        input('\nPress Enter to exit...')
        sys.exit(1)

    try:
        config = load_config()
    except FileNotFoundError:
        print('[*] No config.json found — starting setup...')
        config = {}
    except json.JSONDecodeError as e:
        print(f'[-] Invalid config.json: {e}')
        print('[*] Starting setup to create new config...')
        config = {}
    except Exception as e:
        print(f'[-] Error loading config: {e}')
        print('[*] Starting setup to create new config...')
        config = {}

    if (not config.get('server_url') or
        config.get('server_url', '').startswith('https://your') or
        not config.get('group_id')):
        print('[*] Incomplete configuration — launching setup...')
        config = SetupUI().run()

    print(f'[*] Starting GameZone client for PC: {config.get("pc_name", "Unknown")}')
    GameZoneApp(config).run()
