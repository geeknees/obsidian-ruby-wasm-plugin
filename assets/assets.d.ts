// binary
declare module "*.wasm" {
	const value: Uint8Array;
	export default value;
}

declare module "*.png" {
	const value: Uint8Array;
	export default value;
}
