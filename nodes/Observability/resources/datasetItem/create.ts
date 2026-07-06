import type { IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';

import { throwNotImplemented } from '../../shared/notImplemented';

const showOnlyForDatasetItemCreate = { resource: ['datasetItem'], operation: ['create'] };

export const datasetItemCreateDescription: INodeProperties[] = [
	{
		displayName: 'Dataset Name',
		name: 'datasetName',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: showOnlyForDatasetItemCreate },
		description: 'Name of the dataset to add this item to (created in the backend if it does not already exist)',
	},
	{
		displayName: 'Input',
		name: 'input',
		type: 'json',
		required: true,
		default: '{}',
		displayOptions: { show: showOnlyForDatasetItemCreate },
		description: 'The input payload for this dataset item, as JSON',
	},
	{
		displayName: 'Expected Output',
		name: 'expectedOutput',
		type: 'json',
		required: true,
		default: '{}',
		displayOptions: { show: showOnlyForDatasetItemCreate },
		description: 'The expected/reference output for this dataset item, as JSON — used for offline evals (PRD F7)',
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: showOnlyForDatasetItemCreate },
		options: [
			{
				displayName: 'Metadata',
				name: 'metadata',
				type: 'json',
				default: '{}',
				description: 'Arbitrary JSON metadata to attach to this dataset item',
			},
			{
				displayName: 'Source Trace ID',
				name: 'sourceTraceId',
				type: 'string',
				default: '',
				description: 'If this dataset item was captured from a live trace, the trace ID it originated from',
			},
		],
	},
];

export async function datasetItemCreate(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	return throwNotImplemented.call(this, 'Dataset Item > Create', itemIndex);
}
