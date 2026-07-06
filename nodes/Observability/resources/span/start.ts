import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { throwNotImplemented } from '../../shared/notImplemented';

const showOnlyForSpanStart = { resource: ['span'], operation: ['start'] };

export const spanStartDescription: INodeProperties[] = [
	{
		displayName: 'Span Name',
		name: 'spanName',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. fetch-crm-record',
		displayOptions: { show: showOnlyForSpanStart },
		description: 'Name for the new span — PRD F9 custom spans around arbitrary (non-AI) workflow sections',
	},
	{
		displayName: 'Attributes',
		name: 'attributes',
		type: 'json',
		default: '{}',
		displayOptions: { show: showOnlyForSpanStart },
		description: 'Arbitrary JSON object of attributes to set on the span when it starts',
	},
];

export async function spanStart(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	return throwNotImplemented.call(this, 'Span > Start', itemIndex);
}
