<?php
/**
 * Handshake route: GET /chinvat-bridge/v1/info
 *
 * The Chinvat adapter calls this first to learn the plugin version, which
 * capabilities are live, and how the site is configured, so adapter and
 * plugin never drift.
 *
 * @package ChinvatBridge
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Register the /info route.
 */
function chinvat_bridge_register_info_route(): void {
	register_rest_route(
		CHINVAT_BRIDGE_REST_NS,
		'/info',
		array(
			'methods'             => 'GET',
			'callback'            => 'chinvat_bridge_info_response',
			'permission_callback' => static function () {
				return current_user_can( 'manage_options' )
					? true
					: new WP_Error( 'chinvat_forbidden', __( 'manage_options required.', 'chinvat-bridge' ), array( 'status' => rest_authorization_required_code() ) );
			},
		)
	);
}

/**
 * Build the handshake payload.
 *
 * @return WP_REST_Response
 */
function chinvat_bridge_info_response(): WP_REST_Response {
	$stylesheet = get_stylesheet();
	$template    = get_template();
	$rankmath    = defined( 'RANK_MATH_VERSION' ) ? RANK_MATH_VERSION : ( class_exists( 'RankMath' ) ? 'active' : null );

	$data = array(
		'plugin'         => 'chinvat-bridge',
		'version'        => CHINVAT_BRIDGE_VERSION,
		'schema_version' => CHINVAT_BRIDGE_SCHEMA_VERSION,
		'abilities_api'  => function_exists( 'wp_register_ability' ),
		'mcp_adapter'    => class_exists( '\\WP\\MCP\\Core\\McpAdapter' ) || class_exists( 'McpAdapter' ),
		'writes_enabled' => chinvat_bridge_writes_enabled(),
		'theme'          => array(
			'stylesheet' => $stylesheet,
			'template'   => $template,
			'is_child'   => $stylesheet !== $template,
			'allowed_root' => wp_normalize_path( get_stylesheet_directory() ),
			'allowed_extensions' => chinvat_bridge_allowed_extensions(),
		),
		'rankmath'       => array(
			'active'  => null !== $rankmath,
			'version' => $rankmath,
		),
		'capabilities'   => chinvat_bridge_capability_index(),
	);

	return new WP_REST_Response( $data, 200 );
}

/**
 * Human/agent-readable index of what this plugin exposes, with risk tiers
 * that mirror Chinvat policy (read / act / dangerous).
 *
 * @return array<int,array<string,string>>
 */
function chinvat_bridge_capability_index(): array {
	return array(
		array( 'name' => 'chinvat-bridge/options-get',    'risk' => 'read',      'cap' => 'manage_options' ),
		array( 'name' => 'chinvat-bridge/options-update', 'risk' => 'act',       'cap' => 'manage_options' ),
		array( 'name' => 'chinvat-bridge/theme-list',     'risk' => 'read',      'cap' => 'edit_themes' ),
		array( 'name' => 'chinvat-bridge/theme-read',     'risk' => 'read',      'cap' => 'edit_themes' ),
		array( 'name' => 'chinvat-bridge/theme-write',    'risk' => 'dangerous', 'cap' => 'edit_themes' ),
		array( 'name' => 'chinvat-bridge/rankmath-get',   'risk' => 'read',      'cap' => 'edit_posts' ),
		array( 'name' => 'chinvat-bridge/rankmath-update','risk' => 'act',       'cap' => 'edit_posts' ),
		array( 'name' => 'chinvat-bridge/plugins-list',   'risk' => 'read',      'cap' => 'activate_plugins' ),
		array( 'name' => 'chinvat-bridge/plugins-toggle', 'risk' => 'act',       'cap' => 'activate_plugins' ),
	);
}
