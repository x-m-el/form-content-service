import { Request, Response } from 'express';
import Router from 'express-promise-router';
import { fetchFormDefinition } from '../services/form-definitions';
import { fetchFormDirectories } from '../services/forms-from-config';

const formDefinitionRouter = Router();

formDefinitionRouter.get('/forms', async (_req: Request, res: Response) => {
  const formDirectories = await fetchFormDirectories();
  res.send({ formDirectories });
});

formDefinitionRouter.get('/:id', async (req: Request, res: Response) => {
  const { formTtl, metaTtl, prefix } = await fetchFormDefinition(req.params.id);
  res.send({ formTtl, metaTtl, prefix });
});

export { formDefinitionRouter };
