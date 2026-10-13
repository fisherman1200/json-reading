import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	// 只收集宿主集成测试；fieldHints.unit.js 由 npm run test:unit 单独运行。
	files: 'out/test/**/*.test.js',
});
