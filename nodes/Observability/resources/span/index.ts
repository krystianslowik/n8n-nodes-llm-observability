import type { INodeProperties } from 'n8n-workflow';

import { spanStart, spanStartDescription } from './start';
import { spanEnd, spanEndDescription } from './end';
import { spanAddEvent, spanAddEventDescription } from './addEvent';
import type { ExecuteMap } from '../../shared/types';

const showOnlyForSpan = { resource: ['span'] };

export const spanDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: showOnlyForSpan },
		options: [
			{
				name: 'Start',
				value: 'start',
				action: 'Start a span',
				description: 'Open a new custom span around an arbitrary workflow section (PRD F9)',
			},
			{
				name: 'End',
				value: 'end',
				action: 'End a span',
				description: 'Close a previously started custom span',
			},
			{
				name: 'Add Event',
				value: 'addEvent',
				action: 'Add an event to a span',
				description: 'Record a point-in-time event on a currently open span',
			},
		],
		default: 'start',
	},
	...spanStartDescription,
	...spanEndDescription,
	...spanAddEventDescription,
];

export const spanExecuteMap: ExecuteMap = {
	start: spanStart,
	end: spanEnd,
	addEvent: spanAddEvent,
};
