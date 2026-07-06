import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { throwNotImplemented } from '../../shared/notImplemented';

const showOnlyForSpanEnd = { resource: ['span'], operation: ['end'] };

export const spanEndDescription: INodeProperties[] = [
	{
		displayName: 'Span ID',
		name: 'spanId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: showOnlyForSpanEnd },
		description: 'ID of the span to close — as returned by a preceding Span > Start operation in this workflow',
	},
	{
		displayName: 'Attributes',
		name: 'attributes',
		type: 'json',
		default: '{}',
		displayOptions: { show: showOnlyForSpanEnd },
		description: 'Arbitrary JSON object of attributes to set on the span before it closes (e.g. a status or result summary)',
	},
];

export async function spanEnd(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	return throwNotImplemented.call(this, 'Span > End', itemIndex);
}
