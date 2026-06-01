// vitest.config.ts
import { defineConfig } from "file:///D:/Kamal%20Application/Student%20Post%20Visa%20Tracker/node_modules/.pnpm/vitest@2.1.9_@types+node@20.19.41/node_modules/vitest/dist/config.js";
var vitest_config_default = defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/server.ts",
        "src/config/logger.ts",
        "src/**/index.ts"
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60
      }
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkQ6XFxcXEthbWFsIEFwcGxpY2F0aW9uXFxcXFN0dWRlbnQgUG9zdCBWaXNhIFRyYWNrZXJcXFxcYXBwc1xcXFxiYWNrZW5kXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJEOlxcXFxLYW1hbCBBcHBsaWNhdGlvblxcXFxTdHVkZW50IFBvc3QgVmlzYSBUcmFja2VyXFxcXGFwcHNcXFxcYmFja2VuZFxcXFx2aXRlc3QuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9EOi9LYW1hbCUyMEFwcGxpY2F0aW9uL1N0dWRlbnQlMjBQb3N0JTIwVmlzYSUyMFRyYWNrZXIvYXBwcy9iYWNrZW5kL3ZpdGVzdC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlc3QvY29uZmlnJztcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgdGVzdDoge1xuICAgIGVudmlyb25tZW50OiAnbm9kZScsXG4gICAgZ2xvYmFsczogZmFsc2UsXG4gICAgc2V0dXBGaWxlczogWyd0ZXN0cy9zZXR1cC50cyddLFxuICAgIGluY2x1ZGU6IFsndGVzdHMvKiovKi5zcGVjLnRzJywgJ3Rlc3RzLyoqLyoudGVzdC50cyddLFxuICAgIHJlcG9ydGVyczogWydkZWZhdWx0J10sXG4gICAgY292ZXJhZ2U6IHtcbiAgICAgIHByb3ZpZGVyOiAndjgnLFxuICAgICAgcmVwb3J0ZXI6IFsndGV4dCcsICdodG1sJywgJ2xjb3YnLCAnanNvbi1zdW1tYXJ5J10sXG4gICAgICByZXBvcnRzRGlyZWN0b3J5OiAnY292ZXJhZ2UnLFxuICAgICAgaW5jbHVkZTogWydzcmMvKiovKi50cyddLFxuICAgICAgZXhjbHVkZTogW1xuICAgICAgICAnc3JjLyoqLyouZC50cycsXG4gICAgICAgICdzcmMvc2VydmVyLnRzJyxcbiAgICAgICAgJ3NyYy9jb25maWcvbG9nZ2VyLnRzJyxcbiAgICAgICAgJ3NyYy8qKi9pbmRleC50cycsXG4gICAgICBdLFxuICAgICAgdGhyZXNob2xkczoge1xuICAgICAgICBsaW5lczogNzAsXG4gICAgICAgIGZ1bmN0aW9uczogNzAsXG4gICAgICAgIHN0YXRlbWVudHM6IDcwLFxuICAgICAgICBicmFuY2hlczogNjAsXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBeVgsU0FBUyxvQkFBb0I7QUFFdFosSUFBTyx3QkFBUSxhQUFhO0FBQUEsRUFDMUIsTUFBTTtBQUFBLElBQ0osYUFBYTtBQUFBLElBQ2IsU0FBUztBQUFBLElBQ1QsWUFBWSxDQUFDLGdCQUFnQjtBQUFBLElBQzdCLFNBQVMsQ0FBQyxzQkFBc0Isb0JBQW9CO0FBQUEsSUFDcEQsV0FBVyxDQUFDLFNBQVM7QUFBQSxJQUNyQixVQUFVO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixVQUFVLENBQUMsUUFBUSxRQUFRLFFBQVEsY0FBYztBQUFBLE1BQ2pELGtCQUFrQjtBQUFBLE1BQ2xCLFNBQVMsQ0FBQyxhQUFhO0FBQUEsTUFDdkIsU0FBUztBQUFBLFFBQ1A7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxNQUNGO0FBQUEsTUFDQSxZQUFZO0FBQUEsUUFDVixPQUFPO0FBQUEsUUFDUCxXQUFXO0FBQUEsUUFDWCxZQUFZO0FBQUEsUUFDWixVQUFVO0FBQUEsTUFDWjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
