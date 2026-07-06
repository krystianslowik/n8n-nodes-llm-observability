import type { INodeProperties } from 'n8n-workflow';

import { datasetItemCreate, datasetItemCreateDescription } from './create';
import type { ExecuteMap } from '../../shared/types';

const showOnlyForDatasetItem = { resource: ['datasetItem'] };

export const datasetItemDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: showOnlyForDatasetItem },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a dataset item',
				description: 'Add an input/expected-output pair to a dataset for offline evaluation',
			},
		],
		default: 'create',
	},
	...datasetItemCreateDescription,
];

export const datasetItemExecuteMap: ExecuteMap = {
	create: datasetItemCreate,
};
