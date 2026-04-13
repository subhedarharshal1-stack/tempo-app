/* =========================================================
   TEMPO — Application Logic
   Scoring Engine · Auth · Task Management · UI
   ========================================================= */

// =========================================================
// STATE
// =========================================================

const state = {
  users: JSON.parse(localStorage.getItem('tempo_users') || '[]'),
  currentUser: JSON.parse(localStorage.getItem('tempo_current_user') || 'null'),
  tasks: [],
  completed: [],
  view: 'dashboard',   // 'dashboard' | 'completed'
  modal: null,          // null | 'add' | 'edit'
  editingTaskId: null,
  activeAuthTab: 'login',
  notifPanelOpen: false,
  authView: 'login',       // 'login' | 'forgot' | 'reset' | 'forgot-sent'
  resetToken: null,          // token for the current reset session
};

function loadUserData() {
  if (!state.currentUser) return;
  const k = `tempo_tasks_${state.currentUser.email}`;
  const ck = `tempo_completed_${state.currentUser.email}`;
  state.tasks = JSON.parse(localStorage.getItem(k) || '[]');
  state.completed = JSON.parse(localStorage.getItem(ck) || '[]');
}

function saveUserData() {
  if (!state.currentUser) return;
  const k = `tempo_tasks_${state.currentUser.email}`;
  const ck = `tempo_completed_${state.currentUser.email}`;
  localStorage.setItem(k, JSON.stringify(state.tasks));
  localStorage.setItem(ck, JSON.stringify(state.completed));
}

// =========================================================
// SCORING ENGINE
// Score = Priority Weight × Deadline Urgency
// Priority: High=3, Medium=2, Low=1
// Urgency: increases as deadline approaches (10 → 1)
// =========================================================

// Parse YYYY-MM-DD deadline as end-of-day (23:59:59) in local time.
// This avoids UTC-midnight off-by-one issues for non-UTC timezones.
function parseDeadline(str) {
  if (!str) return new Date(NaN);
  const parts = str.split('-');
  if (parts.length !== 3) return new Date(NaN);
  const [y, m, d] = parts.map(Number);
  return new Date(y, m - 1, d, 23, 59, 59); // local time, end of day
}

function diffDaysFromNow(deadline) {
  return (parseDeadline(deadline) - new Date()) / 86400000;
}

function getUrgencyScore(deadline) {
  const d = diffDaysFromNow(deadline);
  if (isNaN(d)) return 1;
  if (d < 0) return 10;   // Overdue
  if (d < 1) return 9;    // Due today
  if (d < 2) return 7;    // Due tomorrow
  if (d < 3) return 5;    // 2 days
  if (d < 4) return 3.5;  // 3 days
  if (d < 7) return 2.5;  // This week
  if (d < 14) return 1.5;  // Next week
  return 1;                  // 2+ weeks
}

function getPriorityWeight(priority) {
  return { high: 3, medium: 2, low: 1 }[priority] || 1;
}

function getScore(task) {
  return getPriorityWeight(task.priority) * getUrgencyScore(task.deadline);
}

function getUrgencyTier(deadline) {
  const d = diffDaysFromNow(deadline);
  if (d < 2) return 'urgent';
  if (d < 4) return 'soon';
  return 'ontrack';
}

function getDeadlineLabel(deadline) {
  const d = diffDaysFromNow(deadline);
  if (isNaN(d)) return 'No deadline';
  const days = Math.ceil(d);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}

function getDoNextReason(task) {
  const p = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
  const dl = getDeadlineLabel(task.deadline);
  const days = diffDaysFromNow(task.deadline);

  if (days < 0) return `${p} priority · Overdue — needs immediate attention`;
  if (days < 1) return `${p} priority · Due today — start now`;
  if (days < 2) return `${p} priority · Due tomorrow — don't wait`;
  if (days < 4) return `${p} priority · ${dl} — coming up fast`;
  return `${p} priority · ${dl}`;
}

function getSortedTasks() {
  return [...state.tasks].sort((a, b) => getScore(b) - getScore(a));
}

// =========================================================
// NOTIFICATION SYSTEM
// =========================================================

function getNotifications() {
  if (!state.currentUser || !state.tasks.length) return [];
  return state.tasks
    .map(t => {
      const d = diffDaysFromNow(t.deadline);
      let type = null;
      if (d < 0) type = 'overdue';
      else if (d < 1) type = 'due-today';
      else if (d < 2) type = 'due-tomorrow';
      if (!type) return null;
      return { ...t, notifType: type, daysLeft: d };
    })
    .filter(Boolean)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

function getNotifLabel(type) {
  if (type === 'overdue') return 'Overdue — act now';
  if (type === 'due-today') return 'Due today';
  if (type === 'due-tomorrow') return 'Due tomorrow';
  return '';
}

function sendBrowserNotif(task, type) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const label = getNotifLabel(type);
  const pLabel = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
  new Notification(`Tempo: ${task.title}`, {
    body: `${label} · ${pLabel} priority`,
    tag: `tempo-${task.id}`,   // deduplicates OS-level notifications
  });
}

function checkBrowserNotifications() {
  if (!state.currentUser) return;
  const notifs = getNotifications();
  if (!notifs.length) return;

  const todayKey = new Date().toISOString().split('T')[0];
  const storageKey = `tempo_notified_${state.currentUser.email}`;
  const notified = JSON.parse(localStorage.getItem(storageKey) || '{}');
  const updated = { ...notified };
  let anyNew = false;

  notifs.forEach(task => {
    const key = `${task.id}_${todayKey}`;
    if (!notified[key]) {
      sendBrowserNotif(task, task.notifType);
      updated[key] = true;
      anyNew = true;
    }
  });

  if (anyNew) {
    localStorage.setItem(storageKey, JSON.stringify(updated));
    const overdue = notifs.filter(n => n.notifType === 'overdue');
    const dueToday = notifs.filter(n => n.notifType === 'due-today');
    if (overdue.length) {
      showToastVariant(
        `⚠️ ${overdue.length} task${overdue.length > 1 ? 's are' : ' is'} overdue!`,
        'warn'
      );
    } else if (dueToday.length) {
      showToastVariant(
        `⏰ ${dueToday.length} task${dueToday.length > 1 ? 's' : ''} due today!`,
        'warn'
      );
    }
  }
}

async function requestNotifPermission() {
  if (!('Notification' in window)) {
    showToastVariant('Browser notifications not supported.', 'error');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    showToast('Notifications enabled ✓');
    checkBrowserNotifications();
  } else {
    showToastVariant('Permission denied — check browser settings.', 'error');
  }
  render();
}

function showToastVariant(msg, variant) {
  const el = document.getElementById('tempo-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast ${variant} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
}

function toggleNotifPanel() {
  state.notifPanelOpen = !state.notifPanelOpen;
  render();
}

function closeNotifPanel() {
  if (!state.notifPanelOpen) return;
  state.notifPanelOpen = false;
  render();
}

function snoozeTask(taskId) {
  if (!state.currentUser) return;
  // Snooze: mark as notified for today AND tomorrow so it won't surface until 2 days from now
  const todayKey = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = tomorrow.toISOString().split('T')[0];
  const storageKey = `tempo_notified_${state.currentUser.email}`;
  const notified = JSON.parse(localStorage.getItem(storageKey) || '{}');
  notified[`${taskId}_${todayKey}`] = true;
  notified[`${taskId}_${tomorrowKey}`] = true;
  localStorage.setItem(storageKey, JSON.stringify(notified));
  showToast('Snoozed until the day after tomorrow 😴');
  render();
}

// =========================================================
// AUTH
// =========================================================

function authSignUp(name, email, password) {
  if (state.users.find(u => u.email === email)) {
    return { error: 'An account with this email already exists.' };
  }
  const user = { name, email, password };
  state.users.push(user);
  localStorage.setItem('tempo_users', JSON.stringify(state.users));
  return { user };
}

function authLogin(email, password) {
  const user = state.users.find(u => u.email === email && u.password === password);
  return user ? { user } : { error: 'Incorrect email or password.' };
}

// =========================================================
// FORGOT / RESET PASSWORD
// =========================================================

function authForgotPassword(email) {
  const user = state.users.find(u => u.email === email);
  // We never reveal whether an account exists — always succeed silently.
  if (user) {
    // Generate a pseudo-random token and store it with the email + expiry (1 h)
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const expiry = Date.now() + 60 * 60 * 1000; // 1 hour
    const resets = JSON.parse(localStorage.getItem('tempo_resets') || '{}');
    resets[token] = { email, expiry };
    localStorage.setItem('tempo_resets', JSON.stringify(resets));
    state.resetToken = token;
  }
  return { ok: true };
}

function authResetPassword(token, newPassword) {
  const resets = JSON.parse(localStorage.getItem('tempo_resets') || '{}');
  const entry = resets[token];
  if (!entry) return { error: 'Invalid or expired reset link. Please try again.' };
  if (Date.now() > entry.expiry) {
    delete resets[token];
    localStorage.setItem('tempo_resets', JSON.stringify(resets));
    return { error: 'This reset link has expired. Please request a new one.' };
  }
  const idx = state.users.findIndex(u => u.email === entry.email);
  if (idx === -1) return { error: 'Account not found.' };
  state.users[idx].password = newPassword;
  localStorage.setItem('tempo_users', JSON.stringify(state.users));
  delete resets[token];
  localStorage.setItem('tempo_resets', JSON.stringify(resets));
  return { ok: true };
}

function setCurrentUser(user) {
  state.currentUser = user;
  localStorage.setItem('tempo_current_user', JSON.stringify(user));
  // Kick off notification check and recurring interval after login
  setTimeout(checkBrowserNotifications, 1200);
  startNotifInterval();
}

function logout() {
  state.currentUser = null;
  state.tasks = [];
  state.completed = [];
  state.view = 'dashboard';
  state.modal = null;
  state.notifPanelOpen = false;
  clearInterval(_notifInterval);
  localStorage.removeItem('tempo_current_user');
  render();
}

// =========================================================
// TASK OPERATIONS
// =========================================================

function addTask(title, deadline, priority) {
  state.tasks.push({
    id: Date.now().toString(),
    title,
    deadline,
    priority,
    createdAt: new Date().toISOString(),
  });
  saveUserData();
  showToast('Task added ✓');
}

function editTask(id, title, deadline, priority) {
  const i = state.tasks.findIndex(t => t.id === id);
  if (i !== -1) {
    state.tasks[i] = { ...state.tasks[i], title, deadline, priority };
    saveUserData();
    showToast('Task updated ✓');
  }
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  saveUserData();
  showToast('Task removed');
  render();
}

function completeTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  state.tasks = state.tasks.filter(t => t.id !== id);
  state.completed.unshift({ ...task, completedAt: new Date().toISOString() });
  saveUserData();
  showToast('Nice work! Task done ✓');
  render();
}

// =========================================================
// TOAST
// =========================================================

let _toastTimer;
function showToast(msg) {
  const el = document.getElementById('tempo-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// =========================================================
// HELPERS
// =========================================================

function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
  return d.innerHTML;
}

function timeAgo(iso) {
  const h = (new Date() - new Date(iso)) / 3600000;
  if (h < 0.017) return 'Just now';
  if (h < 1) return `${Math.floor(h * 60)}m ago`;
  if (h < 24) return `${Math.floor(h)}h ago`;
  if (h < 48) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// =========================================================
// RENDER ENTRY
// =========================================================

function render() {
  const app = document.getElementById('app');
  if (!state.currentUser) {
    app.innerHTML = renderAuthScreen() + renderToast();
  } else {
    loadUserData();
    app.innerHTML = renderAppShell() + renderToast();
  }
  bindGlobalEvents();
}

function renderToast() {
  return `<div class="toast" id="tempo-toast"></div>`;
}

// =========================================================
// AUTH SCREEN
// =========================================================

function renderAuthScreen() {
  if (state.authView === 'forgot') return renderForgotScreen();
  if (state.authView === 'forgot-sent') return renderForgotSentScreen();
  if (state.authView === 'reset') return renderResetScreen();

  const isLogin = state.activeAuthTab === 'login';
  return `
    <div class="auth-screen">
      <div class="auth-card">

        <div class="auth-brand">
          <div class="auth-logo">⏱</div>
          <h1>Tempo</h1>
          <p>Know exactly what to do next.<br>Every single day.</p>
        </div>

        <div class="tab-group">
          <button class="tab-btn ${isLogin ? 'active' : ''}" id="tab-login"  onclick="switchAuthTab('login')">Log in</button>
          <button class="tab-btn ${!isLogin ? 'active' : ''}" id="tab-signup" onclick="switchAuthTab('signup')">Sign up</button>
        </div>

        <div id="auth-form-wrap">
          ${isLogin ? renderLoginForm() : renderSignupForm()}
        </div>

        <p class="error-msg" id="auth-error"></p>
      </div>
    </div>
  `;
}

function renderForgotScreen() {
  return `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="auth-logo">🔑</div>
          <h1>Forgot password?</h1>
          <p>Enter your registered email and we'll send you a reset link.</p>
        </div>
        <div class="form-group">
          <label for="inp-forgot-email">Email address</label>
          <input type="email" id="inp-forgot-email" placeholder="you@example.com" autocomplete="email">
        </div>
        <p class="error-msg" id="forgot-error"></p>
        <button class="btn-primary" id="forgot-submit-btn" onclick="handleForgotPassword()">Send reset link</button>
        <button class="btn-link" onclick="showAuthView('login')">← Back to login</button>
      </div>
    </div>
  `;
}

function renderForgotSentScreen() {
  return `
    <div class="auth-screen">
      <div class="auth-card auth-card--success">
        <div class="auth-success-icon">✉️</div>
        <h2 class="auth-success-title">Check your inbox</h2>
        <p class="auth-success-body">A password reset link has been sent to your email. It expires in 1 hour.</p>
        <div class="auth-success-divider"></div>
        <p class="auth-success-hint">Didn't get an email? Check your spam folder or
          <button class="btn-inline-link" onclick="showAuthView('forgot')">try again</button>.
        </p>
        ${state.resetToken
      ? `<button class="btn-primary" style="margin-top:20px" onclick="showAuthView('reset')">Set new password →</button>`
      : ''}
        <button class="btn-link" onclick="showAuthView('login')">← Back to login</button>
      </div>
    </div>
  `;
}

function renderResetScreen() {
  return `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">
          <div class="auth-logo">🔒</div>
          <h1>Set new password</h1>
          <p>Choose a strong password you haven't used before.</p>
        </div>
        <div class="form-group">
          <label for="inp-new-password">New password</label>
          <input type="password" id="inp-new-password" placeholder="Min 6 characters" autocomplete="new-password">
        </div>
        <div class="form-group">
          <label for="inp-confirm-password">Confirm password</label>
          <input type="password" id="inp-confirm-password" placeholder="Repeat your new password" autocomplete="new-password">
        </div>
        <p class="error-msg" id="reset-error"></p>
        <button class="btn-primary" id="reset-submit-btn" onclick="handleResetPassword()">Update password</button>
        <button class="btn-link" onclick="showAuthView('login')">← Back to login</button>
      </div>
    </div>
  `;
}

function renderLoginForm() {
  return `
    <div class="form-group">
      <label for="inp-email">Email</label>
      <input type="email" id="inp-email" placeholder="you@example.com" autocomplete="email">
    </div>
    <div class="form-group">
      <label for="inp-password">Password</label>
      <input type="password" id="inp-password" placeholder="••••••••" autocomplete="current-password">
    </div>
    <button class="btn-primary" id="auth-submit-btn" onclick="handleLogin()">Log in to Tempo</button>
    <button class="btn-link" id="forgot-pwd-link" onclick="showAuthView('forgot')">Forgot password?</button>
  `;
}

function renderSignupForm() {
  return `
    <div class="form-group">
      <label for="inp-name">Your name</label>
      <input type="text" id="inp-name" placeholder="Alex" autocomplete="name">
    </div>
    <div class="form-group">
      <label for="inp-email">Email</label>
      <input type="email" id="inp-email" placeholder="you@example.com" autocomplete="email">
    </div>
    <div class="form-group">
      <label for="inp-password">Password</label>
      <input type="password" id="inp-password" placeholder="Min 6 characters" autocomplete="new-password">
    </div>
    <button class="btn-primary" id="auth-submit-btn" onclick="handleSignup()">Create my account</button>
  `;
}

// =========================================================
// APP SHELL
// =========================================================

function renderAppShell() {
  const sorted = getSortedTasks();
  const topTask = sorted[0] || null;
  const urgentCount = sorted.filter(t => getUrgencyTier(t.deadline) === 'urgent').length;
  const initials = state.currentUser.name
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  return `
    <div class="app-shell">
      ${renderNav(initials)}
      <main class="main-content">
        ${state.view === 'dashboard'
      ? renderDashboard(sorted, topTask, urgentCount)
      : renderCompleted()}
      </main>
    </div>
    ${state.modal ? renderModal() : ''}
    ${state.notifPanelOpen ? renderNotifPanel() : ''}
  `;
}

function renderNav(initials) {
  const isDash = state.view === 'dashboard';
  const isDone = state.view === 'completed';
  const notifs = getNotifications();
  const badgeCount = notifs.length;
  const hasOverdue = notifs.some(n => n.notifType === 'overdue');
  const completedLabel = state.completed.length
    ? `Completed (${state.completed.length})`
    : 'Completed';

  const bellClass = hasOverdue
    ? 'notif-btn has-overdue'
    : badgeCount > 0 ? 'notif-btn has-notifs'
      : 'notif-btn';

  const badgeHtml = badgeCount > 0
    ? `<span class="notif-badge">${badgeCount > 9 ? '9+' : badgeCount}</span>`
    : '';

  return `
    <nav class="top-nav">
      <div class="nav-brand">
        <div class="nav-logo">⏱</div>
        <span class="nav-brand-name">Tempo</span>
      </div>

      <div class="nav-tabs">
        <button class="nav-tab ${isDash ? 'active' : ''}" id="nav-tab-dashboard" onclick="switchView('dashboard')">Tasks</button>
        <button class="nav-tab ${isDone ? 'active' : ''}" id="nav-tab-completed" onclick="switchView('completed')">${completedLabel}</button>
      </div>

      <div class="nav-actions">
        <button class="${bellClass}" id="notif-bell-btn"
          onclick="toggleNotifPanel()"
          title="Notifications${badgeCount > 0 ? ' (' + badgeCount + ' urgent)' : ''}"
          aria-label="Notifications">
          🔔${badgeHtml}
        </button>
        <div class="user-chip">
          <div class="avatar">${initials}</div>
          ${esc(state.currentUser.name.split(' ')[0])}
        </div>
        <button class="btn-ghost" id="signout-btn" onclick="logout()">Sign out</button>
      </div>
    </nav>
  `;
}

function renderNotifPanel() {
  const notifs = getNotifications();
  const permGranted = typeof Notification !== 'undefined'
    && Notification.permission === 'granted';
  const permDenied = typeof Notification !== 'undefined'
    && Notification.permission === 'denied';

  const permHtml = permGranted
    ? `<span class="notif-perm-granted">✓ Alerts on</span>`
    : permDenied
      ? `<span class="notif-perm-denied">Alerts blocked</span>`
      : `<button class="notif-perm-btn" id="enable-alerts-btn" onclick="requestNotifPermission()">Enable alerts</button>`;

  const itemsHtml = notifs.length === 0
    ? `<div class="notif-empty">
        <div class="notif-empty-icon">🎯</div>
        <h4>You're all caught up</h4>
        <p>No upcoming or overdue tasks right now.</p>
      </div>`
    : notifs.map(t => `
        <div class="notif-item">
          <div class="notif-dot ${t.notifType}"></div>
          <div class="notif-item-body">
            <div class="notif-item-title">${esc(t.title)}</div>
            <div class="notif-item-desc ${t.notifType}">
              ${getNotifLabel(t.notifType)} · ${t.priority} priority
            </div>
          </div>
          <button class="notif-snooze-btn"
            id="snooze-btn-${t.id}"
            title="Snooze for 2 days"
            onclick="snoozeTask('${t.id}')">
            😴
          </button>
        </div>
      `).join('');

  const footerHtml = permGranted
    ? `<div class="notif-footer-status">
        <span class="notif-footer-icon">🔔</span>
        <span>Browser alerts active — you'll be notified for overdue &amp; due-today tasks.</span>
      </div>`
    : permDenied
      ? `<div class="notif-footer-status denied">
        <span class="notif-footer-icon">🚫</span>
        <span>Alerts blocked in browser settings. Allow notifications for this site to receive reminders.</span>
      </div>`
      : `<div class="notif-footer-status pending">
        <span class="notif-footer-icon">💡</span>
        <span>Enable browser alerts above to get real-time reminders for urgent tasks.</span>
      </div>`;

  return `
    <div class="notif-overlay" id="notif-overlay" onclick="closeNotifPanel()"></div>
    <div class="notif-panel" id="notif-panel" role="dialog" aria-label="Notifications">
      <div class="notif-panel-header">
        <span class="notif-panel-title">🔔 Reminders</span>
        ${permHtml}
      </div>
      <div class="notif-items">${itemsHtml}</div>
      <div class="notif-panel-footer">
        ${footerHtml}
      </div>
    </div>
  `;
}

// =========================================================
// DASHBOARD
// =========================================================

function renderDashboard(sorted, topTask, urgentCount) {
  return `
    ${topTask ? renderDoNextCard(topTask) : renderDoNextEmpty()}

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-number accent">${sorted.length}</div>
        <div class="stat-label">Active</div>
      </div>
      <div class="stat-card">
        <div class="stat-number red">${urgentCount}</div>
        <div class="stat-label">Urgent</div>
      </div>
      <div class="stat-card">
        <div class="stat-number">${state.completed.length}</div>
        <div class="stat-label">Done</div>
      </div>
    </div>

    <div class="section-header">
      <span class="section-title">All Tasks</span>
      <span class="task-count-badge">${sorted.length} task${sorted.length !== 1 ? 's' : ''}</span>
    </div>

    <div class="legend-row">
      <div class="legend-item"><div class="legend-dot red"></div>Due ≤ 1 day</div>
      <div class="legend-item"><div class="legend-dot amber"></div>Due in 2–3 days</div>
      <div class="legend-item"><div class="legend-dot green"></div>On track</div>
    </div>

    <button class="add-task-btn" id="add-task-btn" onclick="openModal('add')">
      <span style="font-size:18px;line-height:1">+</span> Add a task
    </button>

    <div class="task-list" id="task-list">
      ${sorted.length === 0 ? renderEmptyState() : sorted.map(renderTaskCard).join('')}
    </div>
  `;
}

// =========================================================
// DO THIS NEXT CARD
// =========================================================

function renderDoNextCard(task) {
  const tier = getUrgencyTier(task.deadline);
  const reason = getDoNextReason(task);
  const dlLabel = getDeadlineLabel(task.deadline);
  const score = getScore(task).toFixed(1);
  const pLabel = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);

  return `
    <div class="do-next-card">
      <div class="do-next-eyebrow">⚡ Do This Next</div>
      <div class="do-next-title">${esc(task.title)}</div>
      <div class="do-next-reason">🧠 ${reason}</div>
      <div class="do-next-footer">
        <span class="dn-badge">${pLabel} priority</span>
        <span class="dn-badge">📅 ${dlLabel}</span>
        <span class="dn-badge">Score ${score}</span>
        <button class="dn-complete-btn" id="dn-complete-btn" onclick="completeTask('${task.id}')">Mark done ✓</button>
      </div>
    </div>
  `;
}

function renderDoNextEmpty() {
  return `
    <div class="do-next-empty">
      <div class="dn-icon">🎉</div>
      <h3>All clear — you're on top of it</h3>
      <p>No active tasks. Add something and Tempo will tell you where to start.</p>
    </div>
  `;
}

// =========================================================
// TASK CARD
// =========================================================

function renderTaskCard(task) {
  const tier = getUrgencyTier(task.deadline);
  const dlLabel = getDeadlineLabel(task.deadline);
  const score = getScore(task).toFixed(1);

  return `
    <div class="task-card tier-${tier}" id="task-card-${task.id}">
      <div class="task-check" title="Mark complete" onclick="completeTask('${task.id}')">✓</div>
      <div class="task-body">
        <div class="task-title-row">
          <span class="task-name">${esc(task.title)}</span>
          <span class="priority-badge ${task.priority}">${task.priority.toUpperCase()}</span>
        </div>
        <div class="task-meta">
          <span>📅 ${dlLabel}</span>
          <span class="task-score-pill">Score ${score}</span>
        </div>
      </div>
      <div class="task-actions">
        <button class="icon-btn" title="Edit task" onclick="openModal('edit','${task.id}')">✏️</button>
        <button class="icon-btn del" title="Delete task" onclick="deleteTask('${task.id}')">🗑</button>
      </div>
    </div>
  `;
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <span class="es-icon">📋</span>
      <h3>No tasks yet</h3>
      <p>Add your first task and Tempo will tell you exactly where to start.</p>
    </div>
  `;
}

// =========================================================
// COMPLETED VIEW
// =========================================================

function renderCompleted() {
  if (state.completed.length === 0) {
    return `
      <div class="empty-state">
        <span class="es-icon">✅</span>
        <h3>Nothing completed yet</h3>
        <p>Tasks you finish will show up here. Go knock one out!</p>
      </div>
    `;
  }

  return `
    <div class="section-header">
      <span class="section-title">Completed</span>
      <span class="task-count-badge">${state.completed.length} task${state.completed.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="completed-list">
      ${state.completed.map(t => `
        <div class="completed-card">
          <div class="completed-check-icon">✓</div>
          <span class="completed-name">${esc(t.title)}</span>
          <span class="completed-when">${timeAgo(t.completedAt)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// =========================================================
// MODAL — Add / Edit Task
// =========================================================

function renderModal() {
  const isEdit = state.modal === 'edit';
  const task = isEdit ? state.tasks.find(t => t.id === state.editingTaskId) : null;
  const today = todayStr();

  return `
    <div class="modal-overlay" id="modal-overlay" onclick="handleOverlayClick(event)">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-heading">
        <div class="modal-header">
          <h2 class="modal-title" id="modal-heading">${isEdit ? 'Edit task' : 'New task'}</h2>
          <button class="close-btn" onclick="closeModal()" aria-label="Close modal">✕</button>
        </div>

        <div class="form-group">
          <label for="inp-task-title">Task</label>
          <input type="text" id="inp-task-title"
            placeholder="What needs to get done?"
            value="${task ? esc(task.title) : ''}"
            maxlength="120">
        </div>

        <div class="form-group">
          <label for="inp-task-deadline">Deadline</label>
          <input type="date" id="inp-task-deadline"
            min="${today}"
            value="${task ? task.deadline : ''}">
        </div>

        <div class="form-group">
          <label for="inp-task-priority">Priority</label>
          <select id="inp-task-priority">
            <option value="high"   ${task?.priority === 'high' ? 'selected' : ''}>High — must do this</option>
            <option value="medium" ${task?.priority === 'medium' ? 'selected' : ''}>Medium — should do this</option>
            <option value="low"    ${(!task || task.priority === 'low') ? 'selected' : ''}>Low — nice to do</option>
          </select>
        </div>

        <p class="modal-error" id="modal-error"></p>

        <div class="modal-actions">
          <button class="btn-secondary" onclick="closeModal()">Cancel</button>
          <button class="btn-primary" id="modal-save-btn"
            onclick="handleSaveTask('${task?.id || ''}')">
            ${isEdit ? 'Save changes' : 'Add task'}
          </button>
        </div>
      </div>
    </div>
  `;
}

// =========================================================
// EVENT HANDLERS
// =========================================================

function bindGlobalEvents() {
  document.addEventListener('keydown', handleKeyDown, { once: true });
}

function handleKeyDown(e) {
  if (e.key === 'Escape') {
    if (state.modal) closeModal();
  }
  if (e.key === 'Enter') {
    const saveBtn = document.getElementById('modal-save-btn');
    const authBtn = document.getElementById('auth-submit-btn');
    if (saveBtn && document.activeElement?.tagName !== 'SELECT') {
      handleSaveTask(state.editingTaskId || '');
    } else if (authBtn) {
      state.activeAuthTab === 'login' ? handleLogin() : handleSignup();
    }
  }
}

/* Auth */
function showAuthView(view) {
  state.authView = view;
  if (view === 'login' || view === 'signup') {
    state.activeAuthTab = view === 'signup' ? 'signup' : 'login';
  }
  render();
}

function switchAuthTab(tab) {
  state.activeAuthTab = tab;
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
  document.getElementById('auth-form-wrap').innerHTML =
    tab === 'login' ? renderLoginForm() : renderSignupForm();
  document.getElementById('auth-error').textContent = '';
}

function handleLogin() {
  const email = document.getElementById('inp-email')?.value.trim();
  const password = document.getElementById('inp-password')?.value;
  if (!email || !password) {
    showAuthError('Please fill in all fields.');
    return;
  }
  const { user, error } = authLogin(email, password);
  if (error) { showAuthError(error); return; }
  state.authView = 'login';
  setCurrentUser(user);
  render();
}

function handleSignup() {
  const name = document.getElementById('inp-name')?.value.trim();
  const email = document.getElementById('inp-email')?.value.trim();
  const password = document.getElementById('inp-password')?.value;
  if (!name || !email || !password) {
    showAuthError('Please fill in all fields.');
    return;
  }
  if (password.length < 6) {
    showAuthError('Password must be at least 6 characters.');
    return;
  }
  const { user, error } = authSignUp(name, email, password);
  if (error) { showAuthError(error); return; }
  state.authView = 'login';
  setCurrentUser(user);
  render();
}

function handleForgotPassword() {
  const email = document.getElementById('inp-forgot-email')?.value.trim();
  if (!email) {
    const el = document.getElementById('forgot-error');
    if (el) el.textContent = 'Please enter your email address.';
    return;
  }
  authForgotPassword(email);
  showAuthView('forgot-sent');
}

function handleResetPassword() {
  const newPwd = document.getElementById('inp-new-password')?.value;
  const confirmPwd = document.getElementById('inp-confirm-password')?.value;
  const errEl = document.getElementById('reset-error');

  if (!newPwd || !confirmPwd) {
    if (errEl) errEl.textContent = 'Please fill in both fields.';
    return;
  }
  if (newPwd.length < 6) {
    if (errEl) errEl.textContent = 'Password must be at least 6 characters.';
    return;
  }
  if (newPwd !== confirmPwd) {
    if (errEl) errEl.textContent = 'Passwords do not match.';
    return;
  }
  if (!state.resetToken) {
    if (errEl) errEl.textContent = 'Reset session expired. Please start over.';
    return;
  }
  const { ok, error } = authResetPassword(state.resetToken, newPwd);
  if (error) {
    if (errEl) errEl.textContent = error;
    return;
  }
  state.resetToken = null;
  showToastVariant('Password updated! Please log in.', 'success');
  showAuthView('login');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg;
}

/* Modal */
function openModal(type, taskId = null) {
  state.modal = type;
  state.editingTaskId = taskId;
  render();
  setTimeout(() => {
    const inp = document.getElementById('inp-task-title');
    if (inp) inp.focus();
  }, 60);
}

function closeModal() {
  state.modal = null;
  state.editingTaskId = null;
  render();
}

function handleOverlayClick(e) {
  if (e.target.id === 'modal-overlay') closeModal();
}

function handleSaveTask(editId) {
  const title = document.getElementById('inp-task-title')?.value.trim();
  const deadline = document.getElementById('inp-task-deadline')?.value;
  const priority = document.getElementById('inp-task-priority')?.value;

  if (!title) {
    showModalError('Please enter a task name.');
    return;
  }
  if (!deadline) {
    showModalError('Please set a deadline.');
    return;
  }

  editId ? editTask(editId, title, deadline, priority)
    : addTask(title, deadline, priority);

  closeModal();
}

function showModalError(msg) {
  const el = document.getElementById('modal-error');
  if (el) el.textContent = msg;
}

/* Navigation */
function switchView(view) {
  state.view = view;
  render();
}

// =========================================================
// NOTIFICATION INTERVAL
// =========================================================

let _notifInterval;
function startNotifInterval() {
  clearInterval(_notifInterval);
  // Check notifications every 30 minutes while logged in
  _notifInterval = setInterval(() => {
    if (state.currentUser) checkBrowserNotifications();
  }, 30 * 60 * 1000);
}

// =========================================================
// BOOT
// =========================================================

// If already logged in from a previous session, kick off notifications
if (state.currentUser) {
  loadUserData();
  setTimeout(checkBrowserNotifications, 1500);
  startNotifInterval();
}

render();

  startNotifInterval();

render();
