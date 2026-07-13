<?php
/**
 * Settings and accessor functions for Chinvat WP Bridge — Developer Mode.
 *
 * @package ChinvatBridge
 * @since 0.2.0
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Retrieve the full settings array merged with defaults. All keys default false.
 *
 * @return array<string, bool> Settings array.
 */
function chinvat_bridge_settings_get(): array {
	$defaults = array(
		'developer_mode'               => false,
		'cap_theme_write'              => false,
		'cap_child_scaffold'           => false,
		'cap_options_update'           => false,
		'cap_plugins_toggle'           => false,
		'cap_file_write'               => false,
		'cap_wp_cli'                   => false,
		'expert_relax_option_denylist' => false,
		'expert_relax_backup'          => false,
	);

	$saved = get_option( 'chinvat_bridge_settings', array() );
	if ( ! is_array( $saved ) ) {
		$saved = array();
	}

	return array_merge( $defaults, $saved );
}

/**
 * Developer Mode is on if the option is set OR the back-compat constant is truthy.
 *
 * @return bool
 */
function chinvat_bridge_dev_mode(): bool {
	$settings = chinvat_bridge_settings_get();
	if ( ! empty( $settings['developer_mode'] ) ) {
		return true;
	}
	if ( defined( 'CHINVAT_BRIDGE_ENABLE' ) && CHINVAT_BRIDGE_ENABLE ) {
		return true;
	}
	return false;
}

/**
 * A capability is enabled only if Developer Mode is on AND its cap_ toggle is set.
 *
 * @param string $key theme_write|options_update|plugins_toggle|file_write|wp_cli.
 * @return bool
 */
function chinvat_bridge_cap_enabled( string $key ): bool {
	if ( ! chinvat_bridge_dev_mode() ) {
		return false;
	}
	$settings = chinvat_bridge_settings_get();
	return ! empty( $settings[ 'cap_' . $key ] );
}

/**
 * Expert override state.
 *
 * @param string $key relax_option_denylist|relax_backup.
 * @return bool
 */
function chinvat_bridge_expert( string $key ): bool {
	$settings = chinvat_bridge_settings_get();
	return ! empty( $settings[ 'expert_' . $key ] );
}

/**
 * Register the settings submenu under Settings.
 */
function chinvat_bridge_add_admin_menu(): void {
	add_options_page(
		__( 'Chinvat Bridge', 'chinvat-bridge' ),
		__( 'Chinvat Bridge', 'chinvat-bridge' ),
		'manage_options',
		'chinvat-bridge',
		'chinvat_bridge_render_settings_page'
	);
}
add_action( 'admin_menu', 'chinvat_bridge_add_admin_menu' );

/**
 * Register the setting + sanitizer.
 */
function chinvat_bridge_register_settings(): void {
	register_setting(
		'chinvat_bridge_group',
		'chinvat_bridge_settings',
		array( 'sanitize_callback' => 'chinvat_bridge_sanitize_settings' )
	);
}
add_action( 'admin_init', 'chinvat_bridge_register_settings' );

/**
 * Sanitize: cast known keys to bool, drop unknown keys.
 *
 * @param mixed $input Raw input.
 * @return array<string, bool>
 */
function chinvat_bridge_sanitize_settings( $input ): array {
	$known = array(
		'developer_mode',
		'cap_theme_write',
		'cap_child_scaffold',
		'cap_options_update',
		'cap_plugins_toggle',
		'cap_file_write',
		'cap_wp_cli',
		'expert_relax_option_denylist',
		'expert_relax_backup',
	);
	$out = array();
	if ( ! is_array( $input ) ) {
		return $out;
	}
	foreach ( $known as $key ) {
		$out[ $key ] = ! empty( $input[ $key ] );
	}
	return $out;
}

/**
 * Render the settings page.
 */
function chinvat_bridge_render_settings_page(): void {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'Chinvat Bridge Settings', 'chinvat-bridge' ); ?></h1>
		<div class="notice notice-warning">
			<p>
				<strong><?php esc_html_e( 'Warning:', 'chinvat-bridge' ); ?></strong>
				<?php esc_html_e( 'Developer Mode lets an AI agent modify your site. Every capability below is off by default. Enable only what you trust the agent to do, and do not expose the MCP endpoint to untrusted callers or content.', 'chinvat-bridge' ); ?>
			</p>
		</div>
		<form method="post" action="options.php">
			<?php settings_fields( 'chinvat_bridge_group' ); ?>
			<table class="form-table" role="presentation">
				<tbody>
					<?php chinvat_bridge_render_setting_row( 'developer_mode', __( 'Developer Mode', 'chinvat-bridge' ), __( 'Master switch. When off, all write abilities are inert.', 'chinvat-bridge' ) ); ?>
					<?php chinvat_bridge_render_setting_row( 'cap_theme_write', __( 'Theme Write', 'chinvat-bridge' ), __( 'Lets an agent run arbitrary PHP as the web server user (RCE by design).', 'chinvat-bridge' ) ); ?>
					<?php chinvat_bridge_render_setting_row( 'cap_child_scaffold', __( 'Child Theme Scaffold', 'chinvat-bridge' ), __( 'Lets an agent create and activate a child of the active theme as an update-proof target for theme writes.', 'chinvat-bridge' ) ); ?>
					<?php chinvat_bridge_render_setting_row( 'cap_options_update', __( 'Options Update', 'chinvat-bridge' ), __( 'Allows the agent to modify WordPress options (denylist-guarded).', 'chinvat-bridge' ) ); ?>
					<?php chinvat_bridge_render_setting_row( 'cap_plugins_toggle', __( 'Plugins Toggle', 'chinvat-bridge' ), __( 'Enables activating/deactivating plugins.', 'chinvat-bridge' ) ); ?>
					<?php chinvat_bridge_render_setting_row( 'cap_file_write', __( 'File Write (wp-content)', 'chinvat-bridge' ), __( 'Reserved for a later version: whole-site file writes under wp-content.', 'chinvat-bridge' ) ); ?>
					<?php chinvat_bridge_render_setting_row( 'cap_wp_cli', __( 'WP-CLI', 'chinvat-bridge' ), __( 'Reserved for a later version: runs WP-CLI — total control.', 'chinvat-bridge' ) ); ?>
					<?php chinvat_bridge_render_setting_row( 'expert_relax_option_denylist', __( 'Expert: Relax Option Denylist', 'chinvat-bridge' ), __( 'DANGER: allows writing protected options like active_plugins / siteurl. The plugin\'s own settings stay protected regardless.', 'chinvat-bridge' ) ); ?>
					<?php chinvat_bridge_render_setting_row( 'expert_relax_backup', __( 'Expert: Relax Backup', 'chinvat-bridge' ), __( 'DANGER: disables the automatic pre-write backup of theme files.', 'chinvat-bridge' ) ); ?>
				</tbody>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}

/**
 * Render one checkbox row.
 *
 * @param string $key   Setting key.
 * @param string $label Label.
 * @param string $desc  Warning description.
 */
function chinvat_bridge_render_setting_row( string $key, string $label, string $desc ): void {
	$settings = chinvat_bridge_settings_get();
	$checked  = checked( ! empty( $settings[ $key ] ), true, false );
	?>
	<tr>
		<th scope="row"><?php echo esc_html( $label ); ?></th>
		<td>
			<fieldset>
				<label for="chinvat_bridge_<?php echo esc_attr( $key ); ?>">
					<input
						type="checkbox"
						name="chinvat_bridge_settings[<?php echo esc_attr( $key ); ?>]"
						id="chinvat_bridge_<?php echo esc_attr( $key ); ?>"
						value="1"
						<?php echo $checked; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
					/>
					<?php esc_html_e( 'Enable', 'chinvat-bridge' ); ?>
				</label>
				<p class="description">
					<strong><?php esc_html_e( 'Warning:', 'chinvat-bridge' ); ?></strong>
					<?php echo esc_html( $desc ); ?>
				</p>
			</fieldset>
		</td>
	</tr>
	<?php
}
