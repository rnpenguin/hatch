import {
  Class,
  DependencyContainer,
  injectable,
  resolveArgs,
} from '@launchtray/hatch-util';
import express, {Application, NextFunction, Request, RequestHandler, Response} from 'express';
import {
  APIMetadataConsumer,
  APIMetadataParameters,
  Server,
  ServerMiddlewareClass
} from './ServerMiddleware';
import WebSocket from 'ws';
import {OpenAPIMethod, OpenAPIParameter} from './OpenAPI';

export type PathParams = string | RegExp | Array<string | RegExp>;

export interface RouteDefiner {
  (app: Application, server: Server, handler: RequestHandler, apiMetadataConsumer: APIMetadataConsumer): void;
}

const routeDefinersKey = Symbol('routeDefiners');
const rootContainerKey = Symbol('rootContainer');
const wsRoutesKey = Symbol('wsEnabled');

const custom = (routeDefiner: RouteDefiner) => {
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    const requestHandler = async (ctlr: any, req: Request, res: Response, next: NextFunction) => {
      const rootContainer = ctlr[rootContainerKey] as DependencyContainer;
      const container = rootContainer.createChildContainer();
      container.registerInstance('Request', req);
      container.registerInstance('Response', res);
      container.registerInstance('NextFunction', next);
      container.registerInstance('cookie', req.headers.cookie ?? '');
      container.registerInstance('authHeader', req.headers.authorization ?? '');
      const args = resolveArgs(container, target, propertyKey);
      await originalMethod.apply(ctlr, args);
    };

    if (target[routeDefinersKey] == null) {
      target[routeDefinersKey] = [];
    }
    const ctlrRouteDefiner = (
        ctlr: any,
        app: Application,
        server: Server,
        apiMetadataConsumer: APIMetadataConsumer
    ) => {
      routeDefiner(app, server, (req: Request<any>, res: Response, next: NextFunction) => {
        requestHandler(ctlr, req, res, next).catch(next);
      }, apiMetadataConsumer);
    };
    target[routeDefinersKey].push(ctlrRouteDefiner);
  };
};

const websocket = (path: PathParams) => {
  return (target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value;
    const requestHandler = (ctlr: any, webSocket: WebSocket, req: Request, webSocketServer: WebSocket.Server) => {
      const rootContainer = ctlr[rootContainerKey] as DependencyContainer;
      const socketContainer = rootContainer.createChildContainer();
      socketContainer.registerInstance('Request', req);
      socketContainer.registerInstance('WebSocket', webSocket);
      socketContainer.registerInstance('WebSocketServer', webSocketServer);
      socketContainer.registerInstance('cookie', req.headers.cookie ?? '');
      socketContainer.registerInstance('authHeader', req.headers.authorization ?? '');
      const args = resolveArgs(socketContainer, target, propertyKey);
      originalMethod.apply(ctlr, args);
    };

    if (target[routeDefinersKey] == null) {
      target[routeDefinersKey] = [];
    }
    target[routeDefinersKey].push((ctlr: any, app: Application, server: Server) => {
      if (!server[wsRoutesKey]) {
        server[wsRoutesKey] = [];
        server.on('upgrade', (req, socket, head) => {
          let foundRoute = false;
          server[wsRoutesKey].forEach((route: any) => {
            const matchingReq = route.matches(req);
            if (matchingReq != null) {
              foundRoute = true;
              route.wss.handleUpgrade(req, socket, head, (webSocket: WebSocket) => {
                route.wss.emit('connection', webSocket, matchingReq);
              });
            }
          });
          if (!foundRoute) {
            socket.destroy();
          }
        });
      }
      const wss = new WebSocket.Server({noServer: true});
      wss.on('connection', (webSocket: WebSocket, req: Request) => {
        requestHandler(ctlr, webSocket, req, wss);
      });
      server[wsRoutesKey].push({
        matches: (req: Request) => {
          const router = express.Router();
          let matchingRequest = null;
          router.get(path, (req: Request) => {
            matchingRequest = req;
          });
          router(req, {} as any, () => {});
          return matchingRequest;
        },
        wss,
      });
    });
  };
};

export const cleanUpRouting = (app: Application, server: Server) => {
  if (server[wsRoutesKey] != null) {
    server[wsRoutesKey].forEach((route: any) => {
      route.wss.close();
    });
  }
  server[wsRoutesKey] = null;
  server.removeAllListeners('upgrade');
};

export const assignRootContainerToController = (ctlr: any, container: DependencyContainer) => {
  ctlr[rootContainerKey] = container;
};

export const hasControllerRoutes = (maybeController: any) => {
  return maybeController.prototype[routeDefinersKey] != null;
};

type ControllerBoundRouteDefiner = (
    controller: any,
    app: Application,
    server: Server,
    apiMetadataConsumer: APIMetadataConsumer
) => void;

export const middlewareFor = <T extends Class<any>> (target: T): ServerMiddlewareClass => {
  if (!hasControllerRoutes(target)) {
    throw new Error(`Cannot register ${target.name} as middleware, as it has no @routes defined.`);
  }

  const originalRegister = target.prototype.register;
  target.prototype.register = async function(
    app: Application,
    server: Server,
    apiMetadataConsumer: APIMetadataConsumer
  ) {
    if (originalRegister != null) {
      await originalRegister.bind(this)(app, server, apiMetadataConsumer);
    }
    target.prototype[routeDefinersKey].forEach((controllerBoundRouteDefiner: ControllerBoundRouteDefiner) => {
      controllerBoundRouteDefiner(this, app, server, apiMetadataConsumer);
    });
  };
  return target;
};

type HTTPMethodUnion =
  | 'all'
  | 'checkout'
  | 'copy'
  | 'delete'
  | 'get'
  | 'head'
  | 'lock'
  | 'merge'
  | 'mkactivity'
  | 'mkcol'
  | 'move'
  | 'notify'
  | 'options'
  | 'patch'
  | 'post'
  | 'purge'
  | 'put'
  | 'report'
  | 'search'
  | 'subscribe'
  | 'trace'
  | 'unlock'
  | 'unsubscribe';

export type StandardRouteDefiners = {
  [method in HTTPMethodUnion]:
    (path: PathParams, metadata?: APIMetadataParameters) => any;
};

export interface NonStandardRouteDefiners {
  custom: (routeDefiner: RouteDefiner) => any;
  m_search: (path: PathParams, metadata?: APIMetadataParameters) => any;
  websocket: (path: PathParams, metadata?: APIMetadataParameters) => any;
}

export type RouteDefiners = StandardRouteDefiners & NonStandardRouteDefiners;

export const controller: <T>() => (target: Class<T>) => void = injectable;

export const convertExpressPathToOpenAPIPath = (
  path: PathParams,
  paramsIn: {
    [key: string]: Partial<OpenAPIParameter>,
  },
  paramsOut: OpenAPIParameter[],
): string | undefined => {
  if (typeof path === 'string') {
    return path.replace(/:([A-Za-z0-0_]*)/g, (_, param) => {
      paramsOut.push({
        ...paramsIn[param],
        name: param,
        in: 'path',
        required: true,
      });
      return `{${param}}`
    });
  }
  return undefined
};

export const convertExpressMethodToOpenAPIMethod = (method: keyof RouteDefiners): OpenAPIMethod | undefined => {
  if (['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method)) {
    return method as OpenAPIMethod;
  }
  return undefined;
};

const proxy = {
  get(target: RouteDefiners, method: keyof RouteDefiners) {
    let adjustedMethod: string = method;
    if (method === 'custom') {
      return custom;
    }
    if (method === 'websocket') {
      return websocket;
    }
    if (method === 'm_search') {
      adjustedMethod = 'm-search';
    }
    return (path: PathParams, metadata: APIMetadataParameters = {}) => {
      const routeDefiner: RouteDefiner = (app, server, handler, apiMetadataConsumer: APIMetadataConsumer) => {
        const definer = app[adjustedMethod].bind(app) as (path: PathParams, handler: any) => void;
        definer(path, handler);
        const apiMethod = convertExpressMethodToOpenAPIMethod(method);
        const parameters: OpenAPIParameter[] = [];
        const apiPath = convertExpressPathToOpenAPIPath(path, metadata.parameters ?? {}, parameters);
        if (apiMethod && apiPath) {
          const apiMetadata = {
            description: metadata.description ?? '',
            method: apiMethod,
            path: apiPath,
            parameters,
            responses: metadata.responses ?? {
              default: {
                description: '',
              },
            },
          };
          apiMetadataConsumer(apiMetadata);
        }
      };
      return custom(routeDefiner);
    };
  },
};

export default new Proxy({custom} as any, proxy) as RouteDefiners;
