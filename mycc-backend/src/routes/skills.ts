import { FastifyInstance } from 'fastify';
import { jwtAuthMiddleware } from '../middleware/jwt.js';
import { getSSHPool } from '../ssh/pool.js';
import { findUserById } from '../db/client.js';
import matter from 'gray-matter';

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  trigger: string;
  icon: string;
  status: 'installed' | 'available' | 'disabled';
}

// 图标映射（根据 skill 名称推断）
const ICON_MAP: Record<string, string> = {
  'cc-usage': '📊',
  'mycc': '📱',
  'read-gzh': '📖',
  'tell-me': '💬',
  'scheduler': '⏰',
  'setup': '🛠',
  'dashboard': '📋',
  'skill-creator': '🔧',
  'mycc-regression': '🔄',
};

export async function skillsRoutes(fastify: FastifyInstance) {
  // GET /api/skills - 获取用户已安装的技能列表
  fastify.get('/api/skills', {
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
        const skillsDir = `/home/${user.linux_user}/workspace/.claude/skills`;

        // 列出 skills 目录下的子目录
        const lsResult = await sshPool.exec(
          connection,
          `ls -d ${skillsDir}/*/SKILL.md 2>/dev/null || echo ""`
        );

        if (lsResult.exitCode !== 0 || !lsResult.stdout.trim()) {
          return reply.send({
            success: true,
            data: { skills: [], total: 0 },
          });
        }

        const skillPaths = lsResult.stdout.trim().split('\n').filter(Boolean);
        const skills: SkillInfo[] = [];

        for (const skillPath of skillPaths) {
          try {
            const catResult = await sshPool.exec(connection, `cat "${skillPath}"`);
            if (catResult.exitCode !== 0) continue;

            const parsed = matter(catResult.stdout);
            const dirName = skillPath.split('/').slice(-2, -1)[0];

            skills.push({
              id: dirName,
              name: (parsed.data.name as string) || dirName,
              description: (parsed.data.description as string) || '',
              trigger: `/${dirName}`,
              icon: ICON_MAP[dirName] || '⚡',
              status: 'installed',
            });
          } catch {
            // 跳过解析失败的 skill
          }
        }

        return reply.send({
          success: true,
          data: { skills, total: skills.length },
        });
      } finally {
        sshPool.release(connection);
      }
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : '获取技能列表失败',
      });
    }
  });
}