import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';

// This testnet's DNS includes a NAT64 address; Node's family racing stalls on this host.
setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);
