/**
 * 并发控制器
 * 限制全局并发数和每用户并发数
 */

export class ConcurrencyLimiter {
  private globalActive = 0;
  private userActive = new Map<number, number>();
  private globalQueue: Array<() => boolean> = [];
  private userQueues = new Map<number, Array<() => boolean>>();

  constructor(
    private maxGlobal: number = 20,
    private maxPerUser: number = 1
  ) {}

  /**
   * 获取执行许可
   * @param userId 用户 ID
   * @returns Promise<void> 当获得许可时 resolve
   */
  async acquire(userId: number): Promise<void> {
    return new Promise((resolve) => {
      const tryAcquire = (): boolean => {
        const userCount = this.userActive.get(userId) || 0;

        // 检查是否可以执行
        if (this.globalActive < this.maxGlobal && userCount < this.maxPerUser) {
          this.globalActive++;
          this.userActive.set(userId, userCount + 1);
          resolve();
          return true;
        }
        return false;
      };

      // 尝试立即获取
      if (tryAcquire()) {
        return;
      }

      // 加入队列
      this.globalQueue.push(tryAcquire);

      const userQueue = this.userQueues.get(userId) || [];
      userQueue.push(tryAcquire);
      this.userQueues.set(userId, userQueue);
    });
  }

  /**
   * 释放许可
   * @param userId 用户 ID
   */
  release(userId: number): void {
    this.globalActive--;
    const userCount = this.userActive.get(userId) || 0;
    this.userActive.set(userId, Math.max(0, userCount - 1));

    // 处理队列
    this.processQueue();
  }

  private processQueue(): void {
    // 尝试处理全局队列
    let i = 0;
    while (i < this.globalQueue.length) {
      const tryAcquire = this.globalQueue[i];
      if (tryAcquire()) {
        this.globalQueue.splice(i, 1);
      } else {
        i++;
      }
    }

    // 尝试处理用户队列
    for (const [userId, queue] of this.userQueues.entries()) {
      let j = 0;
      while (j < queue.length) {
        const tryAcquire = queue[j];
        if (tryAcquire()) {
          queue.splice(j, 1);
        } else {
          j++;
        }
      }
      if (queue.length === 0) {
        this.userQueues.delete(userId);
      }
    }
  }

  /**
   * 获取当前状态
   */
  getStats() {
    return {
      globalActive: this.globalActive,
      globalQueue: this.globalQueue.length,
      userActive: Object.fromEntries(this.userActive),
      maxGlobal: this.maxGlobal,
      maxPerUser: this.maxPerUser,
    };
  }
}

// 全局实例
export const concurrencyLimiter = new ConcurrencyLimiter(
  parseInt(process.env.MAX_CONCURRENT_USERS || '20'),
  parseInt(process.env.MAX_CONCURRENT_PER_USER || '1')
);
