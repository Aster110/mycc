import { FastifyInstance } from 'fastify';
import { jwtAuthMiddleware } from '../middleware/jwt.js';
import { getSSHPool } from '../ssh/pool.js';
import { findUserById } from '../db/client.js';

export interface AutomationInfo {
  id: string;
  name: string;
  scheduleText: string;
  skill: string;
  description: string;
  status: 'healthy' | 'paused' | 'error';
  enabled: boolean;
  type: 'daily' | 'weekly' | 'once' | 'interval';
}

/**
 * 将 scheduler 的时间格式转为可读文本
 */
function toScheduleText(time: string): string {
  // 每日：HH:MM → "每天 HH:MM"
  if (/^\d{1,2}:\d{2}$/.test(time)) return `每天 ${time}`;
  // 每周：周X HH:MM → "每周X HH:MM"
  if (/^周[一二三四五六日]/.test(time)) return `每${time}`;
  // 间隔：每30分钟 → "每 30 分钟"
  const intervalMatch = time.match(/^每(\d+)(分钟|m|小时|h)$/);
  if (intervalMatch) {
    const unit = intervalMatch[2] === 'm' ? '分钟' : intervalMatch[2] === 'h' ? '小时' : intervalMatch[2];
    return `每 ${intervalMatch[1]} ${unit}`;
  }
  // 一次性
  return time;
}

/**
 * 检测任务类型
 */
function detectType(time: string): AutomationInfo['type'] {
  if (/^每\d+(分钟|m|小时|h)$/.test(time)) return 'interval';
  if (/^周[一二三四五六日]/.test(time)) return 'weekly';
  if (/^\d{4}-\d{2}-\d{2}/.test(time)) return 'once';
  return 'daily';
}

/**
 * 解析 tasks.md 表格为任务列表
 */
function parseTasksMd(content: string): AutomationInfo[] {
  const tasks: AutomationInfo[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('时间') || line.includes('日期时间') || line.includes('---')) continue;

    const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
    if (cells.length < 4) continue;

    const [time, name, skill, desc] = cells;

    // 验证时间格式
    if (!/^\d{1,2}:\d{2}$/.test(time) &&
        !/^周[一二三四五六日]/.test(time) &&
        !/^\d{4}-\d{2}-\d{2}/.test(time) &&
        !/^每\d+(分钟|m|小时|h)$/.test(time)) {
      continue;
    }

    tasks.push({
      id: `${name}-${time}`.replace(/\s+/g, '-').toLowerCase(),
      name,
      scheduleText: toScheduleText(time),
      skill,
      description: desc,
      status: 'healthy',
      enabled: true,
      type: detectType(time),
    });
  }

  return tasks;
}

export async function automationsRoutes(fastify: FastifyInstance) {
  // GET /api/automations - 获取用户的自动化任务列表
  fastify.get('/api/automations', {
    preHandler: jwtAuthMiddleware,
  }, async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: '未认证' });
    }

    try {
      const user = await findUserById(request.user.userId);
      if (!user) {
        return reply.status(404).send({ success: false, error: '用户不存在' });
      }

      const sshPool = getSSHPool();
      const connection = await sshPool.acquire();

      try {
        const tasksPath = `/home/${user.linux_user}/workspace/.claude/skills/scheduler/tasks.md`;

        const catResult = await sshPool.exec(connection, `cat "${tasksPath}" 2>/dev/null || echo ""`);

        const automations = catResult.stdout.trim()
          ? parseTasksMd(catResult.stdout)
          : [];

        return reply.send({
          success: true,
          data: { automations, total: automations.length },
        });
      } finally {
        sshPool.release(connection);
      }
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : '获取自动化任务失败',
      });
    }
  });
}