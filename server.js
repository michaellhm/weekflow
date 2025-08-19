const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json({ limit: '1mb' }));

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

async function ensureFile(filePath, defaultContent) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, JSON.stringify(defaultContent, null, 2), 'utf8');
  }
}

const defaultSettings = {
  workDays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '17:00',
  theme: 'system',
  overrides: {},
  dayOrders: {}
};

async function initStorage() {
  await ensureDir(DATA_DIR);
  await ensureFile(TASKS_FILE, { tasks: [] });
  await ensureFile(SETTINGS_FILE, defaultSettings);
  const defaultUsers = { users: [ { username: 'michael', passwordHash: bcrypt.hashSync('u)D1k4Q|3$U]', 10), role: 'admin' } ] };
  await ensureFile(USERS_FILE, defaultUsers);
}

// Views & static
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.use(express.static(path.join(ROOT, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
}));
app.use((req,res,next)=>{res.locals.user=req.session.user||null; next()});

function requireAuth(req,res,next){ if(!req.session.user){ return res.redirect('/login'); } next() }
function requireAdmin(req,res,next){ if(!req.session.user || req.session.user.role!=='admin'){ return res.status(403).send('Forbidden') } next() }

// Routes
app.get('/', requireAuth, (req, res) => {
  res.render('index');
});

app.get('/login', (req,res)=>{ if(req.session.user) return res.redirect('/'); res.render('login') });
app.post('/api/login', express.urlencoded({extended:true}), async (req,res)=>{
  try{
    const {username,password}=req.body;
    const raw=await fs.readFile(USERS_FILE,'utf8');
    const data=JSON.parse(raw||'{}');
    const user=(data.users||[]).find(u=>u.username===username);
    if(!user) return res.status(401).render('login',{error:'Invalid credentials'});
    const ok=await bcrypt.compare(password||'', user.passwordHash||'');
    if(!ok) return res.status(401).render('login',{error:'Invalid credentials'});
    req.session.user={username:user.username, role:user.role||'user'};
    res.redirect('/');
  }catch{ res.status(500).send('Login failed') }
});
app.post('/api/logout', (req,res)=>{ req.session.destroy(()=>res.redirect('/login')) });
app.get('/api/me', (req,res)=> res.json(req.session.user||null));

// Admin
app.get('/admin', requireAdmin, (req,res)=> res.render('admin'));
app.get('/api/users', requireAdmin, async (req,res)=>{
  try{
    const raw=await fs.readFile(USERS_FILE,'utf8');
    const data=JSON.parse(raw||'{}');
    res.json((data.users||[]).map(u=>({username:u.username, role:u.role||'user'})));
  }catch{
    res.status(500).json({error:'Failed'});
  }
});
app.post('/api/users', requireAdmin, express.json(), async (req,res)=>{
  try{
    const {username,password,role}=req.body;
    if(!username||!password) return res.status(400).json({error:'username and password required'});
    const raw=await fs.readFile(USERS_FILE,'utf8');
    const data=JSON.parse(raw||'{}');
    if((data.users||[]).some(u=>u.username===username)) return res.status(400).json({error:'Exists'});
    data.users=data.users||[];
    data.users.push({username,passwordHash:bcrypt.hashSync(password,10),role:role==='admin'?'admin':'user'});
    await fs.writeFile(USERS_FILE, JSON.stringify(data,null,2),'utf8');
    res.json({ok:true});
  }catch{
    res.status(500).json({error:'Failed'});
  }
});
app.put('/api/users/:username', requireAdmin, express.json(), async (req,res)=>{
  try{
    const u=req.params.username;
    const raw=await fs.readFile(USERS_FILE,'utf8');
    const data=JSON.parse(raw||'{}');
    const i=(data.users||[]).findIndex(x=>x.username===u);
    if(i<0) return res.status(404).json({error:'Not found'});
    if(req.body.password) data.users[i].passwordHash=bcrypt.hashSync(req.body.password,10);
    if(req.body.role) data.users[i].role=req.body.role==='admin'?'admin':'user';
    await fs.writeFile(USERS_FILE, JSON.stringify(data,null,2),'utf8');
    res.json({ok:true});
  }catch{
    res.status(500).json({error:'Failed'});
  }
});
app.delete('/api/users/:username', requireAdmin, async (req,res)=>{
  try{
    const u=req.params.username;
    const raw=await fs.readFile(USERS_FILE,'utf8');
    const data=JSON.parse(raw||'{}');
    data.users=(data.users||[]).filter(x=>x.username!==u);
    await fs.writeFile(USERS_FILE, JSON.stringify(data,null,2),'utf8');
    try{
      const tr=await fs.readFile(TASKS_FILE,'utf8');
      const tdata=JSON.parse(tr||'{}');
      if(tdata.byUser){
        delete tdata.byUser[u];
      } else if(Array.isArray(tdata.tasks)){
        tdata.tasks=tdata.tasks.filter(t=>t.owner!==u);
      }
      await fs.writeFile(TASKS_FILE, JSON.stringify(tdata,null,2),'utf8');
    }catch{}
    res.json({ok:true});
  }catch{
    res.status(500).json({error:'Failed'});
  }
});

// Tasks scoped by user if logged in (back-compat otherwise)
app.get('/api/tasks', async (req, res) => {
  try {
    const raw = await fs.readFile(TASKS_FILE, 'utf8');
    const data = JSON.parse(raw || '{"tasks":[]}');
    const user = (req.session && req.session.user && req.session.user.username) || null;
    if (user) {
      if (data.byUser) {
        return res.json(data.byUser[user] || []);
      }
      const arr = Array.isArray(data.tasks) ? data.tasks : [];
      // Migrate legacy tasks to michael on his first access
      if (user === 'michael' && arr.length) {
        const migrated = arr.map(t => ({ ...t, owner: 'michael' }));
        const newData = { ...data, byUser: { michael: migrated } };
        delete newData.tasks;
        await fs.writeFile(TASKS_FILE, JSON.stringify(newData, null, 2), 'utf8');
        return res.json(migrated);
      }
      // For other users, do not expose owner-less tasks
      return res.json(arr.filter(t => t.owner === user));
    }
    // No session: fall back to legacy array if present
    return res.json(Array.isArray(data.tasks) ? data.tasks : []);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read tasks', details: String(e) });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const tasks = Array.isArray(req.body.tasks) ? req.body.tasks : [];
    const user = (req.session && req.session.user && req.session.user.username) || null;
    if(user){
      const raw = await fs.readFile(TASKS_FILE,'utf8').catch(()=>null);
      let data = raw? JSON.parse(raw): {};
      data.byUser = data.byUser || {};
      data.byUser[user] = (tasks||[]).map(t=> ({...t, owner:user}));
      await fs.writeFile(TASKS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } else {
      await fs.writeFile(TASKS_FILE, JSON.stringify({ tasks }, null, 2), 'utf8');
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to write tasks', details: String(e) });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw || 'null') || defaultSettings;
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read settings', details: String(e) });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const settings = { ...defaultSettings, ...(req.body || {}) };
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to write settings', details: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
initStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`WeekFlow server running on http://localhost:${PORT}`);
  });
});


