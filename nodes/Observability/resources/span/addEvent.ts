import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { throwNotImplemented } from '../../shared/notImplemented';

const showOnlyForSpanAddEvent = { resource: ['span'], operation: ['addEvent'] };

export const spanAddEventDescription: INodeProperties[] = [
	{
		displayName: 'Span ID',
		name: 'spanId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: showOnlyForSpanAddEvent },
		description: 'ID of the currently open span to attach this event to',
	},
	{
		displayName: 'Span Name',
		name: 'spanName',
		type: 'string',
		default: '',
		displayOptions: { show: showOnlyForSpanAddEvent },
		description: 'Name of the event being recorded on the span (e.g. a checkpoint within a long-running step)',
	},
	{
		displayName: 'Attributes',
		name: 'attributes',
		type: 'json',
		default: '{}',
		displayOptions: { show: showOnlyForSpanAddEvent },
		description: 'Arbitrary JSON object of attributes to attach to this event',
	},
];

export async function spanAddEvent(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	return throwNotImplemented.call(this, 'Span > Add Event', itemIndex);
}
