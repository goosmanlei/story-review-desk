import {defineConfig} from '@playwright/test';
import path from 'node:path';
import base from './review-feedback.ui.config';
export default defineConfig({...base,outputDir:path.resolve(import.meta.dirname,'.test-tmp/settings-overhaul-browser'),testMatch:['story-settings.ui.spec.ts','free-canvas.ui.spec.ts','optimization-components.ui.spec.ts']});
