import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/agent": {
				target: "ws://127.0.0.1:8787",
				ws: true,
			},
		},
	},
});
