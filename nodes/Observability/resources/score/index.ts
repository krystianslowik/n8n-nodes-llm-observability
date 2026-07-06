import type { INodeProperties } from 'n8n-workflow';

import { scoreCreate, scoreCreateDescription } from './create';
import type { ExecuteMap } from '../../shared/types';

const showOnlyForScore = { resource: ['score'] };

export const scoreDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: showOnlyForScore },
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a score',
				description: 'Attach a score/feedback value to a trace or span',
			},
		],
		default: 'create',
	},
	...scoreCreateDescription,
];

export const scoreExecuteMap: ExecuteMap = {
	create: scoreCreate,
};
