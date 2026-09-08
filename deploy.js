const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ====================== 【配置区，请按需修改】 ======================
const CONFIG = {
  STATE_FILE: path.resolve('./nginx/AorB'),
  CONTAINER_PORT: 3000,
  HEALTH_PATH: '/api/health',
  MAX_RETRIES: 30,
  DRAIN_TIMEOUT: 60,
  SVC_BLUE: 'api-blue',
  SVC_GREEN: 'api-green',
  NGINX_CONTAINER: 'build‑nginx',
  NGINX_UPSTREAM_INNER: '/etc/nginx/upstream.conf',
  TPL_BLUE: path.resolve('./nginx/upstream.blue.tmpl'),
  TPL_GREEN: path.resolve('./nginx/upstream.green.tmpl'),
};
// =================================================================

// 颜色输出
const COLOR = {
  GREEN: '\033[0;32m',
  YELLOW: '\033[1;33m',
  RED: '\033[0;31m',
  NC: '\033[0m',
};

function info(msg) {
  console.log(`${COLOR.YELLOW}🔍 ${msg}${COLOR.NC}`);
}
function ok(msg) {
  console.log(`${COLOR.GREEN}✅ ${msg}${COLOR.NC}`);
}
function err(msg) {
  console.log(`${COLOR.RED}❌ ${msg}${COLOR.NC}`);
}

/**
 * 执行shell命令，抛出异常代表失败
 */
function runCmd(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * 获取compose服务容器ID
 */
function getContainerId(svc) {
  try {
    const out = runCmd(`docker compose ps -q ${svc}`).trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

/**
 * 获取容器IP
 */
function getContainerIp(svc) {
  const cid = getContainerId(svc);
  if (!cid) return null;
  const out = runCmd(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${cid}`).trim();
  return out || null;
}

/**
 * 等待健康检测，http 200通过
 */
async function waitForHealth(svc) {
  info(`Waiting health for ${svc} ${CONFIG.HEALTH_PATH}`);
  let count = 0;
  while (count < CONFIG.MAX_RETRIES) {
    const ip = getContainerIp(svc);
    if (ip) {
      try {
        // curl 获取http状态码
        const code = runCmd(
          `curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://${ip}:${CONFIG.CONTAINER_PORT}${CONFIG.HEALTH_PATH}`
        ).trim();
        if (code === '200') {
          ok(`${svc} health check passed (HTTP 200)`);
          return;
        }
      } catch (e) {
        // curl失败继续重试
      }
    }
    await sleep(2000);
    count++;
  }
  err(`${svc} health check timeout, abort deploy`);
  throw new Error(`health timeout: ${svc}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待连接耗尽：ss统计established连接
 */
async function waitForDraining(svc) {
  const ip = getContainerIp(svc);
  if (!ip) {
    ok(`${svc} already stopped, skip draining`);
    return;
  }
  info(`Draining active connections for ${svc} ip=${ip}, max ${CONFIG.DRAIN_TIMEOUT}s`);
  let count = 0;
  while (count < CONFIG.DRAIN_TIMEOUT) {
    const out = runCmd(`ss -tn state established dst ${ip}`).trim();
    const lines = out.split('\n').filter((l) => l && !l.includes('Recv-Q'));
    const conn = lines.length;
    if (conn === 0) {
      ok(`No active connections left, safe to stop ${svc}`);
      return;
    }
    info(`Active connections: ${conn}, waiting...`);
    await sleep(1000);
    count++;
  }
  err(`Drain timeout ${CONFIG.DRAIN_TIMEOUT}s, will force‑stop container`);
}

/**
 * 拷贝模板到nginx容器，校验配置并reload
 */
function switchNginxUpstream(tplPath) {
  info(`Switch nginx upstream using template ${tplPath}`);
  // compose cp 把宿主机模板复制进容器
  runCmd(`docker compose cp "${tplPath}" "${CONFIG.NGINX_CONTAINER}:${CONFIG.NGINX_UPSTREAM_INNER}"`);
  // nginx -t 校验配置
  runCmd(`docker compose exec -T ${CONFIG.NGINX_CONTAINER} nginx -t`);
  // reload
  runCmd(`docker compose exec -T ${CONFIG.NGINX_CONTAINER} nginx -s reload`);
  ok('Nginx reloaded, traffic switched');
}

/**
 * 状态文件初始化
 */
function initState() {
  if (!fs.existsSync(CONFIG.STATE_FILE)) {
    fs.mkdirSync(path.dirname(CONFIG.STATE_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.STATE_FILE, 'blue\n', 'utf8');
    info('Init state file: default=blue');
  }
}
function getCurrentEnv() {
  return fs.readFileSync(CONFIG.STATE_FILE, 'utf8').trim();
}
function setState(val) {
  fs.writeFileSync(CONFIG.STATE_FILE, val + '\n', 'utf8');
}

/**
 * 主发布逻辑
 */
async function doDeploy(newSvc, oldSvc, newTpl) {
  info('========================================');
  info(`Deploy: new=${newSvc}  old=${oldSvc}`);
  info('========================================');

  info(`Building ${newSvc} image ...`);
  runCmd(`docker compose build ${newSvc}`);

  info(`Starting new container ${newSvc}`);
  runCmd(`docker compose up -d ${newSvc}`);

  await waitForHealth(newSvc);

  switchNginxUpstream(newTpl);

  await waitForDraining(oldSvc);
  info(`Stopping old container ${oldSvc}`);
  runCmd(`docker compose stop ${oldSvc}`);

  setState(newSvc);
  ok(`Deploy SUCCESS, current online: ${newSvc}`);
}

/**
 * 回滚逻辑
 */
async function doRollback() {
  const curr = getCurrentEnv();
  let rollbackSvc, rollbackTpl;
  if (curr === CONFIG.SVC_BLUE) {
    rollbackSvc = CONFIG.SVC_GREEN;
    rollbackTpl = CONFIG.TPL_GREEN;
  } else {
    rollbackSvc = CONFIG.SVC_BLUE;
    rollbackTpl = CONFIG.TPL_BLUE;
  }

  info('===== ROLLBACK =====');
  info(`Current online: ${curr}, rollback to: ${rollbackSvc}`);

  runCmd(`docker compose up -d ${rollbackSvc}`);
  await waitForHealth(rollbackSvc);

  switchNginxUpstream(rollbackTpl);

  await waitForDraining(curr);
  runCmd(`docker compose stop ${curr}`);

  setState(rollbackSvc);
  ok(`ROLLBACK SUCCESS, now online: ${rollbackSvc}`);
}

async function main() {
  initState();
  const curr = getCurrentEnv();
  info(`Current online instance: ${curr}`);

  const args = process.argv.slice(2);
  if (args[0] === 'rollback') {
    await doRollback();
    return;
  }

  if (curr === CONFIG.SVC_BLUE) {
    await doDeploy(CONFIG.SVC_GREEN, CONFIG.SVC_BLUE, CONFIG.TPL_GREEN);
  } else {
    await doDeploy(CONFIG.SVC_BLUE, CONFIG.SVC_GREEN, CONFIG.TPL_BLUE);
  }
}

main().catch((err) => {
  err(`Process abort: ${err.message}`);
  process.exit(1);
});
