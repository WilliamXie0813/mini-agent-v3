function trimFraction(value: number, digits: number): string {
	return value.toFixed(digits).replace(/\.?0+$/, "");
}

// Durations arrive as high-precision milliseconds. Keep the display useful:
// integer milliseconds below one second, then switch to compact larger units.
export function formatDuration(milliseconds: number): string {
	if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
	if (milliseconds === 0) return "0 ms";
	if (milliseconds < 1) return "<1 ms";
	if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;

	if (milliseconds < 60_000) {
		const seconds = milliseconds / 1_000;
		return `${trimFraction(seconds, seconds < 10 ? 2 : 1)} s`;
	}

	const totalSeconds = Math.round(milliseconds / 1_000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;

	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m ${seconds}s`;
}
