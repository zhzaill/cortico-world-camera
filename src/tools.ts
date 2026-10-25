/**
 * 工具表：bot 能碰到的全部东西。
 *
 * 纪律：这里没有「动作」。相机不驱动任何执行器，所以全部是 read / snapshot。
 * 模型能做的事只有三件：问现在什么样、要一张照片、盯一段时间看有没有变化。
 */

import type { ToolDef, ToolOutcome } from 'cortico/core/types.ts';

export interface CameraOps {
  statusText(): string;
  look(why: string): Promise<ToolOutcome>;
  watch(seconds: number, why: string): Promise<ToolOutcome>;
}

const WHY = {
  type: 'string' as const,
  minLength: 2,
  maxLength: 80,
  description: '一句话说明你为什么要看（会写进操作记录）',
};

export function cameraTools(cam: CameraOps): ToolDef[] {
  return [
    {
      name: 'cam_status',
      description:
        '看看现在这只眼睛什么情况：有没有画面、多新、亮不亮、检测器与提案服务在不在线。不确定画面还算不算数时先问这个。',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      handler: async () => cam.statusText(),
    },
    {
      name: 'cam_look',
      description:
        '拿一张现在的画面。照片只在你调用时产生，不会自动送到你面前；一次只给一张，附一句它看见什么。',
      tags: ['read', 'snapshot'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { why: WHY },
        required: ['why'],
      },
      handler: async (args) => cam.look(String(args.why)),
    },
    {
      name: 'cam_watch',
      description:
        '盯着看一小会儿，回来说这段时间里画面有没有动静、有没有人进出。用来判断"刚才是不是有东西经过"。',
      tags: ['read'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seconds: { type: 'number', minimum: 1, maximum: 15, default: 3, description: '盯多久，单位秒' },
          why: WHY,
        },
        required: ['why'],
      },
      handler: async (args) => cam.watch(Number(args.seconds ?? 3), String(args.why)),
    },
  ];
}
