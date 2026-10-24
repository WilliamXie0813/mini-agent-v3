import { useRef, useState } from "react";
import type * as React from "react";

export const DEFAULT_TIMELINE_WIDTH = 480;
export const MIN_TIMELINE_WIDTH = 320;
export const MAX_TIMELINE_WIDTH = 640;
export const TIMELINE_RESIZE_STEP = 16;

export interface TimelineResizeController {
	timelineWidth: number;
	timelinePointerDown(event: React.PointerEvent<HTMLDivElement>): void;
	timelinePointerMove(event: React.PointerEvent<HTMLDivElement>): void;
	timelinePointerEnd(event: React.PointerEvent<HTMLDivElement>): void;
	timelineKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
}

// Timeline width is local layout state; it is not part of Agent facts.
export function useTimelineWidth(): TimelineResizeController {
	const [timelineWidth, setTimelineWidth] = useState(DEFAULT_TIMELINE_WIDTH);
	const dragRef = useRef<{
		pointerId: number;
		startClientX: number;
		startWidth: number;
	} | null>(null);
	const resize = (width: number) => {
		setTimelineWidth(
			Math.min(MAX_TIMELINE_WIDTH, Math.max(MIN_TIMELINE_WIDTH, width)),
		);
	};
	const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragRef.current = {
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startWidth: timelineWidth,
		};
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// jsdom does not implement pointer capture; browsers do.
		}
	};
	const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		resize(drag.startWidth + drag.startClientX - event.clientX);
	};
	const pointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		try {
			event.currentTarget.releasePointerCapture(event.pointerId);
		} catch {
			// Pointer capture is optional in test environments.
		}
	};
	const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			resize(timelineWidth + TIMELINE_RESIZE_STEP);
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			resize(timelineWidth - TIMELINE_RESIZE_STEP);
		} else if (event.key === "Home") {
			event.preventDefault();
			resize(MIN_TIMELINE_WIDTH);
		} else if (event.key === "End") {
			event.preventDefault();
			resize(MAX_TIMELINE_WIDTH);
		}
	};
	return {
		timelineWidth,
		timelinePointerDown: pointerDown,
		timelinePointerMove: pointerMove,
		timelinePointerEnd: pointerEnd,
		timelineKeyDown: keyDown,
	};
}
