/** WorldDefinition：装配层按这个构造 CameraWorld。 */

import type { WorldDefinition, WorldSection } from 'cortico/world.ts';

import { CAMERA_DEFAULTS, type CameraConfig } from './config.ts';
import { CameraWorld } from './world.ts';

export const CAMERA: WorldDefinition<CameraConfig & WorldSection> = {
  id: 'camera',
  label: '眼睛',

  defaults: () => ({ ...structuredClone(CAMERA_DEFAULTS), enabled: false }),

  create: (ctx) => new CameraWorld(ctx),
};

export default CAMERA;
