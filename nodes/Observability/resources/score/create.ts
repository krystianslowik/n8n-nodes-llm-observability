import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { throwNotImplemented } from '../../shared/notImplemented';

const showOnlyForScoreCreate = { resource: ['score'], operation: ['create'] };

export const scoreCreateDescription: INodeProperties[] = [
	{
		displayName: 'Trace ID',
		name: 'traceId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: showOnlyForScoreCreate },
		description:
			'The trace to attach this score to — typically the trace ID emitted as metadata by an upstream Trace Exporter node (PRD §5 Node B: "attach score ... to a trace ... by traceId from Node A\'s emitted metadata"). Expression-friendly.',
	},
	{
		displayName: 'Score Name',
		name: 'scoreName',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. accuracy, helpfulness',
		displayOptions: { show: showOnlyForScoreCreate },
		description: 'Name of the score/feedback metric',
	},
	{
		displayName: 'Value',
		name: 'value',
		type: 'number',
		required: true,
		default: 0,
		displayOptions: { show: showOnlyForScoreCreate },
		description: 'Numeric value of the score',
	},
	{
		displayName: 'Comment',
		name: 'comment',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		displayOptions: { show: showOnlyForScoreCreate },
		description: 'Optional free-text comment/justification for the score',
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showOnlyForScoreCreate },
		options: [
			{
				displayName: 'Span ID',
				name: 'spanId',
				type: 'string',
				default: '',
				description: 'Attach the score to a specific span within the trace, instead of the trace as a whole',
			},
			{
				displayName: 'Timestamp',
				name: 'timestamp',
				type: 'dateTime',
				default: '',
				description: 'When the score was produced; defaults to "now" at export time if left empty',
			},
		],
	},
];

export async function scoreCreate(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	return throwNotImplemented.call(this, 'Score > Create', itemIndex);
}
