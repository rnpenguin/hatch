# Containers
Containers can be generated by running `hatch container <ModuleName>`

Containers are React Components that are concerned with "how the UI relates to logic in 
[managers](../managers)." These are usually connected to the [Redux](https://redux.js.org) store using 
[React Redux](https://react-redux.js.org), and often also involve [React Router](https://reacttraining.com/react-router)
components.

If you're adding something that represents a "page" or "screen," it's likely a Container.

Whenever you can, prefer using [Components](../components) that are ignorant of Redux and React Router over Containers.
